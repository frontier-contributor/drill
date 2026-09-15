/* ============================================================================
 * memoryCapture.ts — turning "save what we did today" into memory.
 *
 * Two ways in, one path out:
 *
 *   natural language   the model ends its normal reply with a fenced
 *                      `drill-memory` block, which costs no extra call and
 *                      needs no tool-calling support from the backend
 *   /remember          a dedicated extraction pass over the conversation
 *
 * Both land here, and here is where the junk-drawer guards live: local dedup
 * (lib/memoryDedup) before anything is proposed, near-matches converted into
 * `supersedes` merges rather than second rows, and the global cap surfaced
 * rather than silently exceeded.
 *
 * Nothing commits itself except a fact the learner stated outright, which is
 * START-HERE §2.4's one documented exception and has an off switch — the
 * autonomy policy, which `candidates.propose` already applies.
 * ========================================================================== */
import * as candidates from "./candidates";
import * as journalStore from "./journalStore";
import * as store from "./store";
import { normMemType } from "@/services/ai";
import { poolFor } from "@/lib/memoryBrief";
import { classify, globalAtCap, type DedupTarget } from "@/lib/memoryDedup";
import type { Memory, MemoryCandidate, MemoryOrigin, MemoryScope, MemoryType } from "@/types";
import type { SavedMemory } from "@/types/chat";

export interface SaveItem {
  scope: MemoryScope;
  type: MemoryType;
  text: string;
  /** The learner asserted this themselves; the model only transcribed it. */
  stated: boolean;
}

/* -------------------------------------------------------------- the block */

/** Matches the fenced block the chat protocol asks for, anywhere in the reply
 *  (models like to add a closing sentence after it). */
const BLOCK = /```(?:drill-memory|drill_memory)\s*([\s\S]*?)```/i;

export interface ParsedReply {
  /** The reply with the block removed, ready to store and render. */
  cleaned: string;
  /** null when the model did not ask to save anything. */
  items: SaveItem[] | null;
}

/**
 * Pull the save block out of a reply.
 *
 * Operates on the raw markdown *before* it is rendered — never on the
 * generated HTML. Splicing rendered output is how you get an injection bug,
 * and CONTRIBUTING.md forbids it outright.
 *
 * A malformed block is stripped and ignored rather than surfaced: the reply
 * itself is still worth reading, and a JSON error the learner cannot act on
 * is noise.
 */
export function parseReply(reply: string): ParsedReply {
  const m = BLOCK.exec(reply);
  if (!m) return { cleaned: reply, items: null };

  const cleaned = reply.replace(BLOCK, "").replace(/\n{3,}/g, "\n\n").trim();

  let items: SaveItem[] | null = null;
  try {
    const raw = JSON.parse(m[1].trim()) as { items?: Record<string, unknown>[] };
    const list = Array.isArray(raw?.items) ? raw.items : [];
    items = list
      .filter((it) => it && typeof it.text === "string" && it.text.trim())
      .map((it) => ({
        scope: it.scope === "global" ? "global" : ("project" as MemoryScope),
        type: normMemType(it.type),
        text: String(it.text).trim(),
        stated: it.stated === true
      }));
  } catch {
    /* Unparseable block — the reply still stands. */
    items = null;
  }

  return { cleaned, items: items && items.length ? items : null };
}

/* ------------------------------------------------------------- the outcome */

export interface Skipped {
  text: string;
  /** What it duplicated, so the UI can say *why* nothing was saved. */
  existing: Memory;
}

export interface CaptureResult {
  committed: Memory[];
  queued: MemoryCandidate[];
  /** Dropped as duplicates of something already known. */
  skipped: Skipped[];
  /** Global memory is at START-HERE §6's cap and wants consolidating. */
  atCap: boolean;
}

export function isEmpty(r: CaptureResult): boolean {
  return !r.committed.length && !r.queued.length && !r.skipped.length;
}

/**
 * What a save did, in words that match where things went.
 *
 * `/remember` used to say "3 to memory" when all three had gone to the tray,
 * which reads as success and then shows nothing in memory — exactly what
 * "/remember does not work" looks like from the chair.
 */
export function describe(r: CaptureResult): string {
  const parts: string[] = [];
  if (r.committed.length) parts.push(`${r.committed.length} saved to memory`);
  if (r.queued.length) parts.push(`${r.queued.length} waiting in the tray (Settings → Memory)`);
  let s = parts.length
    ? parts.join(" · ")
    : r.skipped.length
      ? r.skipped.length === 1
        ? "Already knew that — memory left alone"
        : "Already knew all of that — memory left alone"
      : "Nothing to save";
  if (r.atCap) s += " · global memory is full, worth tidying";
  return s;
}

/**
 * Fold a new save into one already recorded on the same turn.
 *
 * `/remember` hangs its result on the last assistant turn, which may already
 * carry a receipt from the natural-language path. Replacing it outright loses
 * the earlier record — including the "already knew this" rows, which are the
 * ones that explain why nothing was saved.
 */
export function merge(prev: SavedMemory | undefined, next: SavedMemory): SavedMemory {
  if (!prev) return next;
  const byId = <T extends { id: string }>(a: T[], b: T[]) => {
    const seenIds = new Set(a.map((x) => x.id));
    return [...a, ...b.filter((x) => !seenIds.has(x.id))];
  };
  const seenText = new Set(prev.skipped.map((s) => s.text));
  return {
    committed: byId(prev.committed, next.committed),
    queued: byId(prev.queued, next.queued),
    skipped: [...prev.skipped, ...next.skipped.filter((s) => !seenText.has(s.text))],
    atCap: next.atCap
  };
}

/** Flatten to the compact form stored on the turn. Ids are kept so the inline
 *  block can read a queued item's live state back from the tray rather than
 *  showing a frozen copy of it. */
export function summarise(r: CaptureResult): SavedMemory {
  return {
    committed: r.committed.map((m) => ({ id: m.id, text: m.text, type: m.type })),
    queued: r.queued.map((c) => ({ id: c.id, text: c.text, type: c.type, supersedes: c.supersedes })),
    skipped: r.skipped.map((s) => ({ text: s.text, existingText: s.existing.text })),
    atCap: r.atCap
  };
}

/**
 * Run proposed items through dedup and the autonomy policy.
 *
 * `origin` names the turn this came from — the `MemoryOrigin` field has been
 * declared since the type was written and never had a producer, which is why
 * no memory could previously say where it came from.
 */
export function capture(items: SaveItem[], origin: MemoryOrigin | null): CaptureResult {
  const projectId = store.get().activeProjectId;
  const skipped: Skipped[] = [];
  const drafts: candidates.ProposeInput[] = [];

  const pool = poolFor("both", projectId);

  /* Committed memory is not the whole picture. An item still waiting in the
     tray is not a Memory yet, so asking twice before reviewing it would queue
     a second identical copy — which is exactly the junk drawer this is meant
     to prevent. Seen grows as we go, so two restatements inside one save
     collapse too. */
  const seen: DedupTarget[] = candidates.all().map((c) => ({ id: c.id, text: c.text }));

  for (const it of items) {
    const verdict = classify(it.text, pool);

    if (verdict.kind === "duplicate" && verdict.existing) {
      skipped.push({ text: it.text, existing: verdict.existing });
      continue;
    }

    /* Already queued, or already accepted earlier in this same block. Not
       reported as a skip against a Memory, because there is no Memory to
       point at — it is simply dropped. */
    if (classify(it.text, seen).kind === "duplicate") continue;
    seen.push({ id: "pending", text: it.text });

    drafts.push({
      scope: it.scope,
      projectId: it.scope === "global" ? null : projectId,
      type: it.type,
      text: it.text,
      origin,
      /* A near-match replaces rather than accumulates. This is the only
         producer of `supersedes`, and what makes the tray's "replaces
         existing" badge reachable. */
      supersedes: verdict.kind === "merge" && verdict.existing ? verdict.existing.id : null,
      stated: it.stated
    });
  }

  const { committed, queued } = drafts.length ? candidates.propose(drafts) : { committed: [], queued: [] };

  return { committed, queued, skipped, atCap: globalAtCap(pool) };
}

/**
 * Record the save in today's journal too.
 *
 * `RawLog.via: "chat"` has been in the type since the journal was designed
 * and nothing ever produced it, so a day spent entirely in chat left an empty
 * journal with nothing to distill. This closes that: what you saved from a
 * conversation becomes part of the day's raw record, feeding the existing
 * capture → journal → distill pipeline instead of bypassing it.
 */
export function logToJournal(result: CaptureResult, label: string): void {
  const lines = [...result.committed.map((m) => m.text), ...result.queued.map((c) => c.text)];
  if (!lines.length) return;
  try {
    const projectId = store.get().activeProjectId;
    const entry = journalStore.getOrCreateToday(projectId);
    journalStore.appendRaw(entry, "chat", label, lines.map((t) => "- " + t).join("\n"));
  } catch {
    /* The journal is a bonus here; a failure must not lose the memory. */
  }
}
