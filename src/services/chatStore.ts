/* ============================================================================
 * chatStore.ts — conversations: CRUD, persistence, and the subscription the
 * React layer binds to.
 *
 * Mirrors the shape of services/store.ts (module singleton + subscribe) so
 * both halves of the app work the same way, but persists to IndexedDB
 * because transcripts are far too big for the localStorage blob.
 *
 * Writes are debounced and last-write-wins per conversation. Streaming a
 * reply mutates the active conversation many times a second; persisting each
 * frame would be pointless I/O.
 * ========================================================================== */
import * as U from "@/lib/util";
import * as store from "./store";
import { idbAll, idbBulkPut, idbClear, idbDelete, idbGet, idbPut, STORE_CONV, STORE_META } from "./idb";
import * as persistence from "./persistence";
import { DEFAULT_PERSONA_ID, getPersona } from "@/lib/personas";
import { markdownToText } from "@/lib/plaintext";
import type { ChatMode, Conversation, ConversationMeta, ContextSource, Turn, Usage, Variant } from "@/types/chat";
import type { ChatActionId } from "@/lib/chatActions";
import type { BackendType, Effort } from "@/types";

let metas: ConversationMeta[] = [];
let loaded = false;
let version = 0;
const listeners = new Set<() => void>();

/** Conversations held in memory. The active one always is; others are kept
 *  after being opened so switching back is instant. */
const cache = new Map<string, Conversation>();

function notify() {
  version++;
  listeners.forEach((l) => l());
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function getVersion(): number {
  return version;
}
export function isLoaded(): boolean {
  return loaded;
}

/* ------------------------------------------------------------ persistence */

const pending = new Map<string, ReturnType<typeof setTimeout>>();

function metaOf(c: Conversation): ConversationMeta {
  const last = c.turns[c.turns.length - 1];
  const text = last ? markdownToText(last.variants[last.active]?.content || "") : "";
  return {
    id: c.id,
    projectId: c.projectId,
    title: c.title,
    titled: c.titled,
    created: c.created,
    updated: c.updated,
    pinned: c.pinned,
    archived: c.archived,
    model: c.model,
    turnCount: c.turns.length,
    preview: text.replace(/\s+/g, " ").slice(0, 140)
  };
}

function upsertMeta(c: Conversation) {
  const m = metaOf(c);
  const i = metas.findIndex((x) => x.id === c.id);
  if (i >= 0) metas[i] = m;
  else metas.unshift(m);
}

/** Queue a write. Same conversation twice in quick succession collapses to
 *  one trip to IndexedDB. */
export function persist(c: Conversation, immediate = false): void {
  c.updated = Date.now();
  upsertMeta(c);
  notify();

  const flush = () => {
    pending.delete(c.id);
    void persistence.guard("conversation", idbPut(STORE_CONV, c));
    void persistence.guard("conversation", idbPut(STORE_META, metaOf(c)));
  };

  const t = pending.get(c.id);
  if (t) clearTimeout(t);
  if (immediate) flush();
  else pending.set(c.id, setTimeout(flush, 400));
}

/** Force every queued write out. Called on tab hide so a reply that finished
 *  a moment before you closed the tab is not lost. */
export function flushAll(): void {
  for (const [id, t] of pending) {
    clearTimeout(t);
    const c = cache.get(id);
    if (c) {
      void persistence.guard("conversation", idbPut(STORE_CONV, c));
      void persistence.guard("conversation", idbPut(STORE_META, metaOf(c)));
    }
  }
  pending.clear();
}

/* ------------------------------------------------------------------ load */

export async function init(): Promise<void> {
  if (loaded) return;
  try {
    const rows = await idbAll<ConversationMeta>(STORE_META);
    metas = rows.sort((a, b) => b.updated - a.updated);
  } catch (e) {
    console.error("could not list conversations", e);
    metas = [];
  }
  loaded = true;
  notify();
}

export function list(): ConversationMeta[] {
  return metas;
}

/**
 * Recompute every sidebar row from the transcripts themselves and drop the
 * in-memory cache. Used after restoring a backup, which writes conversation
 * records straight into IndexedDB behind this module's back; it also repairs
 * a meta store that has drifted out of sync for any other reason.
 */
export async function rebuildIndex(): Promise<number> {
  const all = await idbAll<Conversation>(STORE_CONV);
  cache.clear();
  pending.forEach((t) => clearTimeout(t));
  pending.clear();
  await idbClear(STORE_META);
  const rows = all.map((c) => metaOf(repair(c)));
  await idbBulkPut(STORE_META, rows);
  metas = rows.sort((a, b) => b.updated - a.updated);
  loaded = true;
  notify();
  return rows.length;
}

export async function load(id: string): Promise<Conversation | null> {
  const hit = cache.get(id);
  if (hit) return hit;
  const c = await idbGet<Conversation>(STORE_CONV, id);
  if (!c) return null;
  // Records written by an older build may predate fields added since.
  const repaired = repair(c);
  cache.set(id, repaired);
  return repaired;
}

/** Fields added since a record was written get filled in on read, which is
 *  why chat has never needed a bulk migration. v1 additions: projectId,
 *  effort, pinnedAttachments, rolledUpThrough. */
function repair(c: Conversation): Conversation {
  c.turns = (c.turns || []).map((t) => {
    const has = !!(t.variants && t.variants.length);
    /* An assistant turn with no variants and no error is a reply that was in
       flight when the app went away — a reload, a closed tab, a crash. The
       turn is written before the request is made, so it survives; the reply
       does not.

       It used to be given a blank variant like any other, which made it
       indistinguishable from an answer that was genuinely empty: the bubble
       rendered with nothing in it, no explanation, and no Retry, because the
       "failed" state is *no variants at all*. Naming it is what puts the
       Retry button back. */
    if (!has && t.role === "assistant" && !t.error) {
      return { ...t, variants: [], active: 0, error: "Interrupted — the app closed while this reply was arriving." };
    }
    return {
      ...t,
      variants: has ? t.variants : [{ content: "", createdAt: t.createdAt || Date.now() }],
      active: Math.min(Math.max(t.active || 0, 0), Math.max((t.variants || []).length - 1, 0))
    };
  });
  c.context = c.context || [];
  c.usage = c.usage || { promptTokens: 0, completionTokens: 0 };
  c.personaId = c.personaId || DEFAULT_PERSONA_ID;
  /* Conversations that predate projects belong to whichever project the
     migration filed the decks under — the same default one. */
  if (!c.projectId) c.projectId = store.get().activeProjectId;
  if (c.effort === undefined) c.effort = "";
  if (!Array.isArray(c.pinnedAttachments)) c.pinnedAttachments = [];
  if (typeof c.rolledUpThrough !== "number") c.rolledUpThrough = 0;
  if (!Array.isArray(c.actions)) c.actions = [];
  /* "chat" was the first name for the single-call mode, before `deep` made a
     two-value flag inadequate. Renamed rather than kept as an alias so there
     is one spelling of it in the codebase.

     Anything unrecognised — including a thread written before modes existed —
     lands on `direct`. A thread that silently became multi-request because the
     app updated would be a bill the learner never agreed to. */
  if ((c.mode as string) === "chat") c.mode = "direct";
  if (c.mode !== "agent" && c.mode !== "deep" && c.mode !== "direct") c.mode = "direct";
  return c;
}

/** In-memory only — used by the UI to read a conversation it already opened
 *  without going async again. */
export function peek(id: string): Conversation | undefined {
  return cache.get(id);
}

/* -------------------------------------------------------------- mutation */

export interface CreateOpts {
  title?: string;
  personaId?: string;
  model?: string;
  backend?: BackendType | "";
  context?: ContextSource[];
  systemPrompt?: string;
  temperature?: number;
  /** Defaults to the active project. */
  projectId?: string;
  effort?: Effort | "";
  /** Carried from the empty screen's mode picker. Absent means `direct`. */
  mode?: ChatMode;
  /** Carried from the empty screen's capability switches — Web, Think. */
  actions?: ChatActionId[];
}

/**
 * What a new conversation knows about you before you have typed anything.
 *
 * This used to be `[]`. That is why the tutor answered "I don't know
 * anything" when asked what the learner did today: a fresh chat was a bare
 * model with a persona and no access to the app it was sitting inside, and
 * the only way to fix it was to know that Conversation settings existed and
 * to attach sources by hand.
 *
 * Every source here renders to nothing when it has nothing to say
 * (chatContext.renderSource returns null), so a brand-new install pays no
 * tokens for the ones that are empty — but the moment there *is* a day, a
 * journal, a weak card or a memory, the tutor can see it.
 */
export function defaultContext(): ContextSource[] {
  return [
    { kind: "memory", scope: "both", limit: 8 },
    { kind: "today", days: 1 },
    { kind: "journal", days: 7 },
    { kind: "weak", deckId: null },
    { kind: "knowledge" },
    /* Costs nothing until something is on the shelf — every source renders to
       null when it is empty — and the moment one is, a new thread knows what
       the learner has been working on without being configured to. */
    { kind: "figures" }
  ];
}

export function create(opts: CreateOpts = {}): Conversation {
  const persona = getPersona(opts.personaId || DEFAULT_PERSONA_ID);
  const now = Date.now();
  const c: Conversation = {
    id: U.uuid(),
    projectId: opts.projectId || store.get().activeProjectId,
    title: opts.title || "New chat",
    titled: !!opts.title,
    created: now,
    updated: now,
    pinned: false,
    archived: false,
    backend: opts.backend ?? "",
    model: opts.model || "",
    personaId: persona.id,
    systemPrompt: opts.systemPrompt || "",
    temperature: opts.temperature ?? persona.temperature ?? 0.6,
    maxTokens: 4096,
    effort: opts.effort || "",
    mode: opts.mode || "direct",
    context: opts.context ?? defaultContext(),
    pinnedAttachments: [],
    turns: [],
    usage: { promptTokens: 0, completionTokens: 0 },
    rolledUpThrough: 0,
    actions: opts.actions ? [...opts.actions] : []
  };
  cache.set(c.id, c);
  persist(c, true);
  return c;
}

export function remove(id: string): void {
  cache.delete(id);
  metas = metas.filter((m) => m.id !== id);
  const t = pending.get(id);
  if (t) {
    clearTimeout(t);
    pending.delete(id);
  }
  void persistence.guard("conversation", idbDelete(STORE_CONV, id));
  void persistence.guard("conversation", idbDelete(STORE_META, id));
  notify();
}

export function rename(c: Conversation, title: string): void {
  c.title = title.trim().slice(0, 120) || "Untitled";
  c.titled = true;
  persist(c, true);
}

export function setPinned(c: Conversation, pinned: boolean): void {
  c.pinned = pinned;
  persist(c, true);
}

export function setArchived(c: Conversation, archived: boolean): void {
  c.archived = archived;
  persist(c, true);
}

/* ----------------------------------------------------------------- turns */

export function makeTurn(role: Turn["role"], content: string, attachments?: Turn["attachments"]): Turn {
  return {
    id: U.uid("t"),
    role,
    variants: [{ content, createdAt: Date.now() }],
    active: 0,
    attachments,
    createdAt: Date.now()
  };
}

export function activeContent(t: Turn): string {
  return t.variants[t.active]?.content || "";
}

export function addTurn(c: Conversation, t: Turn): Turn {
  c.turns.push(t);
  persist(c);
  return t;
}

export function addVariant(c: Conversation, t: Turn, v: Variant): void {
  t.variants.push(v);
  t.active = t.variants.length - 1;
  persist(c);
}

export function setVariant(c: Conversation, t: Turn, i: number): void {
  t.active = Math.min(Math.max(i, 0), t.variants.length - 1);
  persist(c);
}

/** Drop everything after `index`. Used when a user message is edited or an
 *  assistant reply is regenerated from further up. */
export function truncateAfter(c: Conversation, index: number): void {
  c.turns = c.turns.slice(0, index + 1);
  persist(c);
}

export function removeTurn(c: Conversation, id: string): void {
  c.turns = c.turns.filter((t) => t.id !== id);
  persist(c);
}

export function addUsageTo(c: Conversation, u: Usage | undefined): void {
  if (!u) return;
  c.usage = {
    promptTokens: c.usage.promptTokens + u.promptTokens,
    completionTokens: c.usage.completionTokens + u.completionTokens,
    cost: c.usage.cost == null && u.cost == null ? undefined : (c.usage.cost || 0) + (u.cost || 0)
  };
}

/** Copy a conversation up to and including `turnIndex` into a new one, so a
 *  tangent can be followed without derailing the thread it came from. */
export function branch(c: Conversation, turnIndex: number, title?: string): Conversation {
  const copy = create({
    title: title || (c.titled ? c.title + " ↗" : undefined),
    personaId: c.personaId,
    model: c.model,
    backend: c.backend,
    context: [...c.context],
    systemPrompt: c.systemPrompt,
    temperature: c.temperature,
    projectId: c.projectId,
    effort: c.effort
  });
  copy.maxTokens = c.maxTokens;
  copy.pinnedAttachments = c.pinnedAttachments.map((a) => ({ ...a }));
  copy.turns = c.turns.slice(0, turnIndex + 1).map((t) => ({
    ...t,
    id: U.uid("t"),
    variants: [{ ...t.variants[t.active] }],
    active: 0
  }));
  persist(copy, true);
  return copy;
}

/* ---------------------------------------------------------------- search */

export interface SearchHit {
  meta: ConversationMeta;
  snippet: string;
}

/** Full-text across every transcript. Reads all records from IndexedDB, which
 *  is fine at the scale one person generates and avoids maintaining an index
 *  that could drift out of sync with the conversations themselves. */
export async function search(query: string): Promise<SearchHit[]> {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const all = await idbAll<Conversation>(STORE_CONV);
  const hits: SearchHit[] = [];
  for (const c of all) {
    if (c.title.toLowerCase().includes(q)) {
      hits.push({ meta: metaOf(c), snippet: c.title });
      continue;
    }
    for (const t of c.turns || []) {
      const text = t.variants?.[t.active]?.content || "";
      const at = text.toLowerCase().indexOf(q);
      if (at >= 0) {
        const start = Math.max(0, at - 60);
        hits.push({
          meta: metaOf(c),
          snippet: (start ? "…" : "") + markdownToText(text.slice(start, at + q.length + 90)).replace(/\s+/g, " ")
        });
        break;
      }
    }
  }
  return hits.sort((a, b) => b.meta.updated - a.meta.updated).slice(0, 50);
}

/* ---------------------------------------------------------------- export */

export function toMarkdown(c: Conversation): string {
  const head = `# ${c.title}\n\n*${new Date(c.created).toLocaleString()} · ${c.model || "unknown model"}*\n`;
  const body = c.turns
    .map((t) => {
      const who = t.role === "user" ? "You" : "Assistant";
      const attach = (t.attachments || []).map((a) => `> attached: ${a.name}`).join("\n");
      return `\n---\n\n### ${who}\n\n${attach ? attach + "\n\n" : ""}${activeContent(t)}`;
    })
    .join("\n");
  return head + body + "\n";
}

export async function exportAll(): Promise<string> {
  const all = await idbAll<Conversation>(STORE_CONV);
  return JSON.stringify({ kind: "drill-conversations", v: 1, conversations: all }, null, 1);
}

export async function importAll(raw: string): Promise<number> {
  const j = JSON.parse(raw) as { conversations?: Conversation[] };
  const list = j.conversations || [];
  if (!Array.isArray(list)) throw new Error("Expected a conversations array.");
  for (const c of list) {
    if (!c || !c.id || !Array.isArray(c.turns)) continue;
    /* Merge semantics: a fresh id so importing the same file twice does not
       overwrite what is already here. Full-backup restore preserves ids
       instead — see services/backup.ts. */
    const fixed = repair({ ...c, id: U.uuid() });
    cache.set(fixed.id, fixed);
    await idbPut(STORE_CONV, fixed);
    await idbPut(STORE_META, metaOf(fixed));
    metas.unshift(metaOf(fixed));
  }
  notify();
  return list.length;
}
