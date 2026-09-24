/* ============================================================================
 * tools.ts — what the assistant can actually do.
 *
 * One catalogue, compiled to whichever protocol the backend speaks
 * (services/agent/protocol.ts). Everything reads or writes through the
 * existing stores; there is no second path to the data, which is the only
 * reason a tool and the deterministic context builder can be trusted to agree.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS CATALOGUE IS SHORT
 *
 * The first version had eleven tools, five of which were searches:
 * memory_search, cards_search, journal_search, notes_search, knowledge_search.
 * That is precisely the failure Anthropic's tool-design guidance names — if a
 * competent engineer cannot say which tool a given question needs, a model
 * cannot either, and the wasted call is a whole request. They are now one
 * `recall` with a `source` filter, which is both fewer decisions and a better
 * default: "search everything" is usually the right first move and was
 * previously impossible to express.
 *
 * The names are verbs a person would use — recall, open, remember, forget —
 * rather than namespaced identifiers. A model choosing between "remember" and
 * "note" is answering a question about intent; one choosing between
 * "memory_write" and "journal_append" is answering a question about our
 * storage layout, which it should not have to know.
 *
 * THREE RULES, each preventing a specific failure:
 *
 *   Cap every result. A tool that returns sixty cards has spent the context
 *   window on step one. Every list tool clamps its limit and says how many it
 *   did not show — "…and 40 more" is what makes a model narrow its query
 *   instead of assuming it saw everything.
 *
 *   Return handles, not dumps. Results carry [mem:id] / [card:id] / [day:...]
 *   references and a one-line summary; `open` expands one. That is
 *   just-in-time retrieval: the model pays for detail only where it decided
 *   detail was worth having.
 *
 *   Writes propose. START-HERE §2.4 says nothing commits itself, and giving
 *   the model hands is not a reason to drop that — so every write goes through
 *   services/candidates and the project's own autonomy policy, the same gate
 *   distill passes through. Under `manual` the tray fills and nothing lands;
 *   under `auto` it lands. The tool does not decide.
 * ========================================================================== */
import * as store from "@/services/store";
import * as memoryStore from "@/services/memoryStore";
import * as journalStore from "@/services/journalStore";
import * as candidates from "@/services/candidates";
import * as U from "@/lib/util";
import { extractKeywords, retrieve } from "@/lib/memoryRetrieval";
import { classify } from "@/lib/memoryDedup";
import { poolFor } from "@/lib/memoryBrief";
import { normMemType } from "@/services/ai";
import { MEMORY_TYPES_ENUM, type PlanItem, type Tool, type ToolContext, type ToolResult } from "@/types/agent";
import type { Card, Deck, Memory, MemoryScope, SRSState } from "@/types";

/* ------------------------------------------------------------ arg reading */

/* The model will send a number as a string, omit an optional argument, or
   invent an enum value. None of those are worth failing a whole step over, so
   every argument is coerced and clamped rather than validated. */

function str(args: Record<string, unknown>, key: string, fallback = ""): string {
  const v = args[key];
  return typeof v === "string" ? v.trim() : v == null ? fallback : String(v).trim();
}

function num(args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const raw = args[key];
  const n = typeof raw === "number" ? raw : parseFloat(String(raw ?? ""));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function bool(args: Record<string, unknown>, key: string): boolean {
  const v = args[key];
  return v === true || v === "true";
}

function oneOf<T extends string>(args: Record<string, unknown>, key: string, allowed: readonly T[], fallback: T): T {
  const v = str(args, key);
  return (allowed.find((a) => a === v) as T) || fallback;
}

/* ---------------------------------------------------------------- shaping */

/** "…and N more" rather than a silent cut. A model that thinks it saw the
 *  whole list will answer as if it did. */
function withMore(lines: string[], total: number, shown: number): string {
  const more = total - shown;
  return lines.join("\n") + (more > 0 ? `\n…and ${more} more not shown. Narrow the query if you need them.` : "");
}

/** ok:false, but still a sentence. An empty result with no explanation is what
 *  makes a model call the same tool three times in a row. */
function miss(text: string): ToolResult {
  return { ok: false, text };
}

function ok(text: string, extra: Partial<ToolResult> = {}): ToolResult {
  return { ok: true, text, ...extra };
}

/** A card at a glance. The answer is included because a front like "m" or
 *  "x⁽ⁱ⁾" says nothing on its own — the same reason lib/dayBrief.ts quotes the
 *  back. `open` gives the whole thing. */
function cardLine(c: Card, st: SRSState | undefined, deckName?: string): string {
  const front = U.stripTags(c.q);
  const back = U.stripTags(c.a);
  const short = back.length > 120 ? back.slice(0, 120) + "…" : back;
  let state = "not yet seen";
  if (st && st.reps) {
    if (store.isLeech(st)) state = `FAILING — ${st.lapses} lapses`;
    else if (st.lapses > 0) state = `${st.lapses} lapses`;
    else state = "healthy";
    if (st.due <= Date.now()) state += ", due now";
  }
  return `[card:${c.id}]${deckName ? ` (${deckName})` : ""} (${c.tag}) [${state}] ${front} => ${short}`;
}

function memoryLine(m: Memory): string {
  const age = Math.round((Date.now() - m.updatedAt) / U.DAY);
  const bits: string[] = [m.type];
  if (m.scope === "global") bits.push("global");
  if (m.pinned) bits.push("pinned");
  if (m.topic) bits.push("topic: " + m.topic);
  /* Age is shown because memory staleness is the failure mode this whole
     system is least protected against — a fact that was true eight months ago
     is stated with exactly the same confidence as one from yesterday, and the
     model should be able to see the difference. */
  bits.push(age < 1 ? "today" : age === 1 ? "1 day old" : `${age} days old`);
  return `[mem:${m.id}] (${bits.join(", ")}) ${m.text}`;
}

/** Keyword overlap over the same tokeniser retrieval and dedup use, so "what
 *  counts as a word" has exactly one answer in this codebase. Returns 1 for an
 *  empty query, which makes an unfiltered listing fall out of the same path. */
function matches(queryWords: string[], text: string): number {
  if (!queryWords.length) return 1;
  const hay = new Set(extractKeywords(text));
  const hits = queryWords.filter((w) => hay.has(w)).length;
  return hits / queryWords.length;
}

/* ------------------------------------------------------------ write gating */

/** Whether the loop may change anything in this project. Resolved the same way
 *  services/candidates does it, so the agent and distill cannot disagree about
 *  the learner's own setting. */
function autonomy(projectId: string): "manual" | "assisted" | "auto" {
  const p = store.projects()[projectId];
  return p?.memoryPolicy?.autonomy || store.settings().autonomy || "assisted";
}

function blockedByManual(what: string): ToolResult {
  /* Not an error — the learner set this. Saying so plainly stops the model
     retrying and then apologising for a refusal it caused. */
  return miss(`${what} is on manual for this project, so nothing can be saved from a conversation. Tell them what you would have saved.`);
}

/* ============================================================ ORIENTATION */

const overview: Tool = {
  name: "overview",
  description:
    "Where this project stands right now: the learner's stated goal, decks and sizes, what is due, what they are " +
    "failing, journal and memory counts. Cheap and broad. Call it first when you do not know what you are looking at.",
  scope: "project",
  kind: "read",
  schema: { properties: {}, required: [] },
  run(_args, ctx) {
    const p = store.projects()[ctx.projectId];
    if (!p) return miss("That project no longer exists.");
    const decks = store.decksOf(ctx.projectId);
    const now = Date.now();
    let due = 0;
    let leeches = 0;
    let unseen = 0;
    let total = 0;
    for (const d of decks) {
      for (const c of d.cards) {
        total++;
        const st = d.srs[c.id];
        if (!st || !st.reps) unseen++;
        else {
          if (st.due <= now) due++;
          if (store.isLeech(st)) leeches++;
        }
      }
    }
    const entries = journalStore.listForProject(ctx.projectId);
    const mem = poolFor("both", ctx.projectId);
    const topics = memoryStore.topics({ projectId: ctx.projectId });
    return ok(
      [
        `Project: ${p.name}${p.blurb ? ` — ${p.blurb}` : ""}`,
        p.goals ? `Their stated goal: ${p.goals}` : "No goal written for this project yet.",
        `Decks (${decks.length}): ${decks.map((d) => `${d.name} (${d.cards.length})`).join(", ") || "none"}`,
        `Cards: ${total} total, ${due} due now, ${leeches} being failed repeatedly, ${unseen} never seen.`,
        `Journal: ${entries.length} entries, ${entries.filter((e) => e.summary).length} written up.`,
        `Memory: ${mem.filter((m) => m.scope === "project").length} for this project, ${mem.filter((m) => m.scope === "global").length} global.`,
        topics.length ? `Memory topics: ${topics.slice(0, 12).map((t) => `${t.topic} (${t.count})`).join(", ")}` : "No memory topics filed yet.",
        `Insight log: ${store.notesOf(ctx.projectId).length} notes.`
      ].join("\n")
    );
  }
};

/* ================================================================= RECALL */

const SOURCES = ["all", "memory", "cards", "journal", "notes", "files"] as const;
type Source = (typeof SOURCES)[number];

const recall: Tool = {
  name: "recall",
  description:
    "Search everything known about this learner in one call — what they have told you (memory), their flashcards " +
    "and how each is going, their daily journal, their insight log, and any reference material attached to the " +
    "project. Leave `source` as \"all\" unless you specifically want one kind; searching everything is usually " +
    "the right first move. Results are one line each and carry a [ref] you can pass to `open` for the full text.",
  scope: "global",
  kind: "read",
  schema: {
    properties: {
      query: { type: "string", description: "Keywords, not a sentence. Empty returns the most recent of each source." },
      source: {
        type: "string",
        description: "Narrow to one kind of thing. Default searches all of them.",
        enum: SOURCES,
        default: "all"
      },
      limit: { type: "number", description: "Results per source, 1-15.", default: 6 }
    },
    required: ["query"]
  },
  maxChars: 3600,
  run(args, ctx) {
    const query = str(args, "query");
    const source = oneOf<Source>(args, "source", SOURCES, "all");
    const limit = num(args, "limit", 6, 1, 15);
    const words = extractKeywords(query);
    const want = (s: Source) => source === "all" || source === s;
    const blocks: string[] = [];
    const inProject = !!store.projects()[ctx.projectId];

    /* ---- memory ---- */
    if (want("memory")) {
      const pool = poolFor("both", ctx.projectId);
      const trace = retrieve(pool, { queryText: query, limit, maxChars: 1800 });
      if (trace.picked.length) {
        /* Usage is recorded here rather than in the loop, because this is the
           moment a memory actually reached the model. Telemetry that counts
           previews is telemetry that lies. */
        for (const m of trace.picked) memoryStore.recordUsage(m.id);
        blocks.push("MEMORY:\n" + withMore(trace.picked.map(memoryLine), trace.considered.length, trace.picked.length));
      }
    }

    /* ---- cards ---- */
    if (want("cards") && inProject) {
      const decks = store.decksOf(ctx.projectId);
      const rows: { d: Deck; c: Card; st?: SRSState; rank: number }[] = [];
      for (const d of decks) {
        for (const c of d.cards) {
          const score = matches(words, U.stripTags(c.q) + " " + U.stripTags(c.a) + " " + c.tag);
          if (!score) continue;
          const st = d.srs[c.id];
          const trouble = st ? (store.isLeech(st) ? 100 : 0) + (st.lapses || 0) : 0;
          rows.push({ d, c, st, rank: score * 10 + trouble });
        }
      }
      if (rows.length) {
        rows.sort((a, b) => b.rank - a.rank);
        const shown = rows.slice(0, limit);
        blocks.push(
          "CARDS:\n" +
            withMore(shown.map((r) => cardLine(r.c, r.st, decks.length > 1 ? r.d.name : undefined)), rows.length, shown.length)
        );
      }
    }

    /* ---- journal ---- */
    if (want("journal") && inProject) {
      const hits = journalStore
        .listForProject(ctx.projectId)
        .map((e) => {
          const hay = e.summary
            ? [e.summary.narrative, ...e.summary.learned, ...e.summary.stuck, ...e.summary.open].join(" ")
            : e.raw.map((r) => r.text).join(" ");
          return { e, score: matches(words, hay) };
        })
        .filter((x) => x.score > 0);
      if (hits.length) {
        hits.sort((a, b) => b.score - a.score || b.e.day.localeCompare(a.e.day));
        const shown = hits.slice(0, limit);
        blocks.push(
          "JOURNAL:\n" +
            withMore(
              shown.map(({ e }) => {
                const head = e.summary ? e.summary.narrative : "(not written up) " + e.raw.map((r) => r.text).join(" ");
                return `[day:${e.day}] ${head.length > 180 ? head.slice(0, 180) + "…" : head}`;
              }),
              hits.length,
              shown.length
            )
        );
      }
    }

    /* ---- insight log ---- */
    if (want("notes") && inProject) {
      const hits = store.notesOf(ctx.projectId).filter((n) => matches(words, n.text + " " + n.tag) > 0).reverse();
      if (hits.length) {
        const shown = hits.slice(0, limit);
        blocks.push(
          "THEIR OWN NOTES (their phrasing — build on it where you can):\n" +
            withMore(shown.map((n) => `- (${n.tag || "note"}, ${U.ago(n.t)}) ${n.text}`), hits.length, shown.length)
        );
      }
    }

    /* ---- attached files ---- */
    if (want("files") && inProject) {
      const items = (store.projects()[ctx.projectId]?.knowledge || []).filter((k) => k.enabled);
      const hits: { name: string; para: string; score: number }[] = [];
      for (const k of items) {
        for (const para of k.text.split(/\n{2,}/)) {
          const clean = para.trim();
          if (clean.length < 40) continue;
          const score = matches(words, clean);
          if (score > 0) hits.push({ name: k.name, para: clean.slice(0, 400), score });
        }
      }
      if (hits.length) {
        hits.sort((a, b) => b.score - a.score);
        const shown = hits.slice(0, Math.min(limit, 4));
        blocks.push("ATTACHED MATERIAL:\n" + withMore(shown.map((h) => `--- ${h.name} ---\n${h.para}`), hits.length, shown.length));
      }
    }

    if (!blocks.length) {
      return miss(
        `Nothing found for "${query}"${source === "all" ? "" : ` in ${source}`}. ` +
          "That is a real answer — say so rather than searching again with the same words."
      );
    }
    return ok(blocks.join("\n\n"));
  }
};

/* =================================================================== OPEN */

const open: Tool = {
  name: "open",
  description:
    "Read one thing in full, by the [ref] a recall result gave you: [mem:id] for a memory, [card:id] for a card " +
    "and its complete review history, [day:YYYY-MM-DD] for a whole journal entry including the raw notes. Use " +
    "this when a one-line summary is not enough to answer properly.",
  scope: "global",
  kind: "read",
  schema: {
    properties: {
      ref: { type: "string", description: 'A reference from a recall result, e.g. "card:abc123" or "day:2026-09-01".' }
    },
    required: ["ref"]
  },
  maxChars: 2600,
  run(args, ctx) {
    const raw = str(args, "ref").replace(/^\[|\]$/g, "");
    const [kind, ...rest] = raw.split(":");
    const id = rest.join(":");
    if (!kind || !id) return miss('A ref looks like "card:abc123", "mem:abc123" or "day:2026-09-01".');

    if (kind === "mem") {
      const m = memoryStore.get(id);
      if (!m) return miss(`No memory with id ${id}.`);
      const links = (m.links || []).map((l) => memoryStore.get(l)).filter(Boolean) as Memory[];
      return ok(
        [
          memoryLine(m),
          `Recorded ${U.ago(m.created)}, last changed ${U.ago(m.updatedAt)}, used ${m.useCount} time${m.useCount === 1 ? "" : "s"}.`,
          `Source: ${m.source}${m.active ? "" : " — RETIRED, no longer true"}`,
          links.length ? "Related:\n" + links.map(memoryLine).join("\n") : ""
        ]
          .filter(Boolean)
          .join("\n")
      );
    }

    if (kind === "card") {
      for (const d of store.decksOf(ctx.projectId)) {
        const c = d.cards.find((x) => x.id === id);
        if (!c) continue;
        const st = d.srs[c.id];
        /* The review history is the point of opening a card: the grades say
           whether they know it, and the attempts say how they were thinking,
           which is the only one of the two you can actually teach against. */
        const log = store
          .get()
          .log.filter((e) => e.c === c.id)
          .slice(-8)
          .reverse();
        return ok(
          [
            `[card:${c.id}] (${c.tag}) in deck "${d.name}"`,
            `Front: ${U.stripTags(c.q)}`,
            `Back: ${U.stripTags(c.a)}`,
            st && st.reps
              ? `State: ${st.reps} reviews, ${st.lapses} lapses${store.isLeech(st) ? " — FAILING" : ""}, due ${U.ago(st.due)}.`
              : "State: never reviewed.",
            log.length
              ? "Recent attempts:\n" +
                log
                  .map((e) => {
                    const g = e.g === 1 ? "failed" : e.g === 2 ? "hard" : e.g === 3 ? "good" : "easy";
                    return `- ${U.ago(e.t)}: ${g}${e.a ? `, they wrote${e.v ? ` (marked ${e.v})` : ""}: "${e.a}"` : ""}`;
                  })
                  .join("\n")
              : "No recorded attempts."
          ].join("\n")
        );
      }
      return miss(`No card with id ${id} in this project.`);
    }

    if (kind === "day") {
      const e = journalStore.byDay(ctx.projectId, id);
      if (!e) return miss(`No journal entry for ${id}.`);
      const parts = [`Journal — ${e.day}`];
      if (e.summary) {
        const s = e.summary;
        parts.push(s.narrative);
        if (s.learned.length) parts.push("Learned:\n" + s.learned.map((x) => "- " + x).join("\n"));
        if (s.stuck.length) parts.push("Stuck:\n" + s.stuck.map((x) => "- " + x).join("\n"));
        if (s.open.length) parts.push("Still open:\n" + s.open.map((x) => "- " + x).join("\n"));
      }
      if (e.raw.length) {
        parts.push("Raw notes as captured:\n" + e.raw.map((r) => `- ${r.text.slice(0, 400)}`).join("\n"));
      }
      return ok(parts.join("\n\n"));
    }

    return miss(`Unknown reference kind "${kind}". Use mem:, card: or day:.`);
  }
};

/* ============================================================= REVIEW LOG */

const reviews: Tool = {
  name: "reviews",
  description:
    "How the last few days of reviewing went: what was graded, what failed, and — the valuable part — the " +
    "sentences the learner typed when recalling from memory. A grade says they got it wrong; what they wrote " +
    "says how they were thinking. Read this before diagnosing any misunderstanding.",
  scope: "project",
  kind: "read",
  schema: {
    properties: {
      days: { type: "number", description: "How far back, 1-30.", default: 7 },
      failed_only: { type: "string", description: 'Pass "true" for only the cards that failed or were hard.' }
    },
    required: []
  },
  maxChars: 3000,
  run(args, ctx) {
    const days = num(args, "days", 7, 1, 30);
    const deckIds = new Set(store.decksOf(ctx.projectId).map((d) => d.id));
    const from = new Date().setHours(0, 0, 0, 0) - (days - 1) * U.DAY;
    const entries = store.get().log.filter((e) => e.t >= from && deckIds.has(e.d));
    if (!entries.length) return miss(`Nothing reviewed in the last ${days} days.`);

    const failed = entries.filter((e) => e.g === 1);
    const hard = entries.filter((e) => e.g === 2);
    const cardOf = (deckId: string, cardId?: string) =>
      cardId ? store.get().decks[deckId]?.cards.find((c) => c.id === cardId) : undefined;

    const parts = [
      `Over ${days} day${days === 1 ? "" : "s"}: ${entries.length} reviews, ` +
        `${entries.length - failed.length - hard.length} clean, ${hard.length} hard, ${failed.length} failed.`
    ];
    const rough = [...failed, ...hard].slice(0, 12);
    if (rough.length) {
      parts.push(
        "Did not go well:\n" +
          rough
            .map((e) => {
              const c = cardOf(e.d, e.c);
              return `- [${e.g === 1 ? "failed" : "hard"}]${c ? ` [card:${c.id}]` : ""} ${c ? U.stripTags(c.q) : "a card since deleted"}`;
            })
            .join("\n")
      );
    }
    const attempts = (bool(args, "failed_only") ? [...failed, ...hard] : entries).filter((e) => e.a).slice(-8).reverse();
    if (attempts.length) {
      parts.push(
        "What they wrote from memory, in their own words:\n" +
          attempts
            .map((e) => {
              const c = cardOf(e.d, e.c);
              return `- Card: ${c ? U.stripTags(c.q) : "unknown"}\n  They wrote${e.v ? ` (marked ${e.v})` : ""}: "${e.a}"`;
            })
            .join("\n")
      );
    }
    return ok(parts.join("\n\n"));
  }
};

/* ================================================================= WRITES */

const remember: Tool = {
  name: "remember",
  description:
    "Record one durable fact about the learner — how they think, a framing that worked, something they have " +
    "settled on, something left unresolved. Only what is still worth knowing in six months. NEVER record what " +
    "the app computes live (which cards are failing, how many are due, streaks): those go stale and become " +
    "confidently wrong. Recall first — a near-duplicate is offered as a replacement rather than a second entry.",
  scope: "global",
  kind: "write",
  schema: {
    properties: {
      text: { type: "string", description: "The fact, one to three sentences. One fact per call." },
      type: { type: "string", description: "What kind of thing this is.", enum: MEMORY_TYPES_ENUM },
      scope: {
        type: "string",
        description: 'global only for facts true of them everywhere; anything subject-specific is "project".',
        enum: ["global", "project"],
        default: "project"
      },
      topic: {
        type: "string",
        description: 'Short subject slug grouping related memories, e.g. "backprop". Reuse an existing topic where one fits.'
      },
      stated: {
        type: "string",
        description: 'Pass "true" ONLY when they asserted this outright and you are transcribing. Your own summary is never stated.'
      }
    },
    required: ["text", "type"]
  },
  run(args, ctx) {
    const text = str(args, "text");
    if (text.length < 8) return miss("Too short to be worth remembering. Write the whole fact.");
    if (autonomy(ctx.projectId) === "manual") return blockedByManual("Memory");

    const scope = (str(args, "scope", "project") === "global" ? "global" : "project") as MemoryScope;
    const verdict = classify(text, poolFor("both", ctx.projectId));
    if (verdict.kind === "duplicate" && verdict.existing) {
      return miss(`Already known — "${verdict.existing.text}". Nothing saved, and nothing needed saving.`);
    }

    const { committed, queued } = candidates.propose([
      {
        scope,
        projectId: scope === "global" ? null : ctx.projectId,
        type: normMemType(str(args, "type")),
        text,
        topic: str(args, "topic").toLowerCase().slice(0, 40) || null,
        origin: { conversationId: ctx.conversationId, turnId: ctx.turnId },
        /* The only producer of `supersedes`: a near-match replaces rather than
           accumulates, which is what keeps memory from becoming a transcript
           of every time the same idea was mentioned. */
        supersedes: verdict.kind === "merge" && verdict.existing ? verdict.existing.id : null,
        stated: bool(args, "stated")
      }
    ]);

    const made = [
      ...committed.map((m) => ({ id: m.id, text: m.text, kind: "memory" as const })),
      ...queued.map((c) => ({ id: c.id, text: c.text, kind: "memory" as const }))
    ];
    const replacing = verdict.kind === "merge" && verdict.existing ? ` It replaces: "${verdict.existing.text}".` : "";
    return committed.length
      ? ok("Saved to memory." + replacing, { committed: made })
      : ok(
          "Queued for the learner to review — it is NOT saved yet." +
            replacing +
            " Say it is waiting for them; do not say you remembered it.",
          { proposed: made }
        );
  }
};

const forget: Tool = {
  name: "forget",
  description:
    "Retire a memory that is wrong, stale, or superseded — use it when you find something in memory that the " +
    "learner has just contradicted. Soft and reversible; the entry is kept and can be restored. Pinned memories " +
    "are refused. Takes the id from a [mem:...] ref.",
  scope: "global",
  kind: "write",
  schema: {
    properties: {
      ref: { type: "string", description: "The memory, as [mem:id] or just the id." },
      reason: { type: "string", description: "Why it is no longer true. Shown to the learner." }
    },
    required: ["ref", "reason"]
  },
  run(args, ctx) {
    if (autonomy(ctx.projectId) === "manual") return blockedByManual("Memory");
    const id = str(args, "ref").replace(/^\[?mem:/, "").replace(/\]$/, "");
    const verdict = memoryStore.retire(id, null);
    if (verdict === "unknown-id") return miss(`No memory with id ${id}. Use recall to get a real one.`);
    if (verdict === "pinned") return miss("That one is pinned — the learner asked to keep it. Refused.");
    if (verdict === "already-retired") return miss("Already retired.");
    return ok(`Retired. Reason recorded: ${str(args, "reason")}`);
  }
};

const draft_card: Tool = {
  name: "draft_card",
  description:
    "Propose one flashcard for the learner to accept. It must be atomic (one fact — if the answer needs \"and\", " +
    "it is two cards), self-contained (answerable in six months with no memory of this conversation — never " +
    '"the trick above" or "as discussed"), and demand recall rather than recognition (never yes/no, never ' +
    "pick-from-list). You cannot add it to the deck yourself.",
  scope: "project",
  kind: "write",
  schema: {
    properties: {
      q: { type: "string", description: "The front. A question only answerable by knowing the thing." },
      a: { type: "string", description: "The back. Short, exact, complete on its own." },
      tag: { type: "string", description: "A one- or two-word topic tag." }
    },
    required: ["q", "a"]
  },
  run(args, ctx) {
    const q = str(args, "q");
    const a = str(args, "a");
    if (!q || !a) return miss("A card needs both a front and a back.");
    if (!store.decksOf(ctx.projectId).length) return miss("This project has no deck to put a card in yet.");
    const card = store.normCard({ tag: str(args, "tag", "General"), q, a });
    return ok("Drafted. The learner has to accept it before it enters the deck — do not say it is added.", {
      proposed: [{ id: card.id, text: U.stripTags(card.q), kind: "card" }]
    });
  }
};

const journal_add: Tool = {
  name: "journal_add",
  description:
    "Add a line to today's journal — something worth recording that came out of this conversation and that they " +
    "have not written down. Raw capture: it costs nothing, is never destroyed, and is not a summary.",
  scope: "project",
  kind: "write",
  schema: {
    properties: { text: { type: "string", description: "What to record. One or two sentences." } },
    required: ["text"]
  },
  run(args, ctx) {
    if (autonomy(ctx.projectId) === "manual") return blockedByManual("The journal");
    const text = str(args, "text");
    if (text.length < 8) return miss("Too short to record.");
    const entry = journalStore.getOrCreateToday(ctx.projectId);
    journalStore.appendRaw(entry, "chat", "assistant", text);
    return ok(`Added to the journal for ${entry.day}.`);
  }
};

/* ================================================================== PLAN */

/* The plan tools do not touch a store. They write to the run's scratch, which
   lives exactly as long as the message — the durable record is the AgentTrace
   saved on the turn. A plan that outlived its answer would be a to-do list
   nobody owns. */

const plan_set: Tool = {
  name: "plan",
  opensPlan: true,
  description:
    "State what you are going to do, before you do it. Restate the question as you understood it, then list the " +
    "specific things you need to find out — one line each, in the order you will do them. Three to six steps is " +
    "usually right; if it needs more than six you are over-thinking the question. Call this once, first, then " +
    "work the list.",
  scope: "global",
  kind: "read",
  schema: {
    properties: {
      goal: { type: "string", description: "The question restated as you understand it. One sentence." },
      steps: {
        type: "string",
        description: "The steps, one per line. Each names something concrete you will find out or do."
      }
    },
    required: ["goal", "steps"]
  },
  run(args, ctx) {
    const goal = str(args, "goal");
    const lines = str(args, "steps")
      .split(/\r?\n|(?:^|\s)\d+[.)]\s+/)
      .map((l) => l.replace(/^[-*•]\s*/, "").trim())
      .filter((l) => l.length > 2)
      .slice(0, 8);
    if (!lines.length) return miss("A plan needs at least one step, one per line.");

    const items: PlanItem[] = lines.map((text, i) => ({ id: String(i + 1), text, status: i === 0 ? "doing" : "todo", note: "" }));
    ctx.scratch.plan = { goal, items };
    ctx.scratch.emit({ kind: "plan", plan: ctx.scratch.plan });
    return ok(
      `Plan set with ${items.length} step${items.length === 1 ? "" : "s"}. Step 1 is in progress.\n` +
        items.map((it) => `${it.id}. [${it.status}] ${it.text}`).join("\n") +
        "\nWork them in order. Call plan_step to close each one as you finish it."
    );
  }
};

const plan_step: Tool = {
  name: "plan_step",
  description:
    "Close out one step of your plan and say what it found, in one line. Mark it \"dropped\" (with why) if it " +
    "turned out not to matter — that is a legitimate outcome and better than pretending to do it. You must " +
    "close every step before you answer.",
  scope: "global",
  kind: "read",
  schema: {
    properties: {
      id: { type: "string", description: "The step number from your plan." },
      status: { type: "string", description: "How it ended.", enum: ["done", "dropped"], default: "done" },
      note: { type: "string", description: "What it found, one line. This is what the learner reads." }
    },
    required: ["id", "note"]
  },
  run(args, ctx) {
    const plan = ctx.scratch.plan;
    if (!plan) return miss("No plan yet — call plan first.");
    const id = str(args, "id").replace(/[^0-9]/g, "");
    const item = plan.items.find((i) => i.id === id);
    if (!item) return miss(`No step ${id}. Steps are: ${plan.items.map((i) => i.id).join(", ")}.`);

    item.status = oneOf(args, "status", ["done", "dropped"] as const, "done");
    item.note = str(args, "note").slice(0, 300);
    /* Advance the first outstanding step, so "what is happening now" is always
       answerable without the model having to declare it separately. */
    const next = plan.items.find((i) => i.status === "todo");
    if (next) next.status = "doing";
    ctx.scratch.emit({ kind: "plan", plan });

    const left = plan.items.filter((i) => i.status === "todo" || i.status === "doing");
    return ok(
      left.length
        ? `Step ${id} ${item.status}. Still open: ${left.map((i) => `${i.id}. ${i.text}`).join(" | ")}`
        : `Step ${id} ${item.status}. Every step is closed — write your answer now.`
    );
  }
};

const note: Tool = {
  name: "note",
  description:
    "Jot down something you have worked out, so it survives even if the details behind it scroll away. Use it " +
    "for a conclusion, not a copy of a tool result. The learner sees these.",
  scope: "global",
  kind: "read",
  schema: {
    properties: { text: { type: "string", description: "One sentence. A conclusion, not raw data." } },
    required: ["text"]
  },
  run(args, ctx) {
    const text = str(args, "text").slice(0, 400);
    if (text.length < 4) return miss("Nothing to note.");
    ctx.scratch.notes.push(text);
    ctx.scratch.emit({ kind: "note", text });
    return ok("Noted.");
  }
};

/* =================================================================== WEB */

/* Voice mode's way onto the web. In text chat the Web switch sends every
   message through OpenRouter's search; in voice there is no switch to throw,
   so searching is a decision the model makes per question — and a question
   that needs no search never pays for one. */
const web_lookup: Tool = {
  name: "web_lookup",
  description:
    "Search the live web and get back a short answer with its sources. For anything current or outside this " +
    "learner's record — news, prices, releases, documentation, facts you are unsure of. Never for questions about " +
    "the learner themselves; their record is in the other tools. One focused question per call.",
  scope: "global",
  kind: "read",
  maxChars: 2400,
  schema: {
    properties: { query: { type: "string", description: "What to find out, as a full question." } },
    required: ["query"]
  },
  async run(args, ctx) {
    const query = str(args, "query");
    if (query.length < 3) return miss("Say what to search for.");
    if (!ctx.web) return miss("Web search is not available here.");
    const found = await ctx.web(query, ctx.signal);
    if (!found.text.trim()) return miss("The search came back with nothing usable.");
    const sources = found.citations
      .slice(0, 5)
      .map((c, i) => `[${i + 1}] ${c.title || c.url} — ${c.url}`)
      .join("\n");
    return ok(found.text.trim() + (sources ? "\n\nSources:\n" + sources : ""));
  }
};

/* ============================================================== catalogue */

/** Tools every mode gets. Ordered as a model reads them: orient, look, read
 *  closely, then act. */
const CORE: Tool[] = [overview, recall, open, reviews, remember, forget, draft_card, journal_add];

/** Deep mode only. In the reactive mode they would be pure overhead — a
 *  two-lookup question does not need a plan, and forcing one would make the
 *  cheap mode cost three requests to answer what one could. */
const DEEP_ONLY: Tool[] = [plan_set, plan_step, note];

/** Voice mode only, and only where the backend can search. */
const VOICE_ONLY: Tool[] = [web_lookup];

export const TOOLS: Tool[] = [...CORE, ...DEEP_ONLY, ...VOICE_ONLY];

/**
 * Each tool as a person would say it: `done` for the trace under a reply,
 * `doing` for voice mode's status line and the line it says aloud while a
 * lookup runs. Keyed by each tool's own `name`, so a rename carries its words
 * with it — the trace used to keep this list to itself, and the voice would
 * have needed a second copy.
 */
export const TOOL_WORDS: Record<string, { doing: string; done: string }> = {
  [overview.name]: { doing: "Checking where this project stands", done: "Checked where this project stands" },
  [recall.name]: { doing: "Searching your record", done: "Searched your record" },
  [open.name]: { doing: "Reading that in full", done: "Read one in full" },
  [reviews.name]: { doing: "Checking your reviews", done: "Read how your reviews went" },
  [remember.name]: { doing: "Saving that", done: "Saved to memory" },
  [forget.name]: { doing: "Retiring that memory", done: "Retired a memory" },
  [draft_card.name]: { doing: "Drafting a card", done: "Drafted a card" },
  [journal_add.name]: { doing: "Adding it to your journal", done: "Added to your journal" },
  [plan_set.name]: { doing: "Making a plan", done: "Wrote a plan" },
  [plan_step.name]: { doing: "Working through the plan", done: "Closed a step" },
  [note.name]: { doing: "Noting that", done: "Noted a conclusion" },
  [web_lookup.name]: { doing: "Searching the web", done: "Searched the web" }
};
export const TOOLS_BY_NAME: Record<string, Tool> = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

export interface ToolsForOpts {
  /** False is the scratch thread — global memory only, no decks or journal. */
  inProject: boolean;
  /** False turns the loop read-only: it still investigates, it just cannot
   *  change anything. The catalogue is filtered rather than the model being
   *  asked nicely, because "please do not write" is not a permission model. */
  allowWrites: boolean;
  /** Deep mode gets the plan tools; so does voice ("auto"), which may plan
   *  when a request needs it and is not made to when it does not. */
  planning: boolean | "auto";
  /** Voice mode, on a backend that can search: the web is a tool. */
  web?: boolean;
}

export function toolsFor(opts: ToolsForOpts): Tool[] {
  return TOOLS.filter((t) => {
    if (!opts.inProject && t.scope === "project") return false;
    if (!opts.allowWrites && t.kind === "write") return false;
    if (!opts.planning && DEEP_ONLY.includes(t)) return false;
    if (!opts.web && VOICE_ONLY.includes(t)) return false;
    return true;
  });
}

/** Run one call against the catalogue, with the cap applied here rather than
 *  trusted to each tool. A tool that ignores its own ceiling is a bug; a loop
 *  that lets it through is a worse one. */
export async function runTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const tool = TOOLS_BY_NAME[name];
  if (!tool) {
    return miss(`No tool called "${name}". Available: ${TOOLS.map((t) => t.name).join(", ")}.`);
  }
  try {
    const res = await tool.run(args, ctx);
    const cap = tool.maxChars ?? 1500;
    if (res.text.length > cap) {
      return { ...res, text: res.text.slice(0, cap) + `\n…truncated at ${cap} characters. Ask for less next time.` };
    }
    return res;
  } catch (e) {
    /* A thrown tool must not take down the loop. The model gets told what
       broke and can route around it — which is exactly the behaviour that
       makes an agent worth having over a pipeline. */
    return miss(`${name} failed: ${(e as Error)?.message || String(e)}`);
  }
}
