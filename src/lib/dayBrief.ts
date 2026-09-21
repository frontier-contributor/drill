/* ============================================================================
 * dayBrief.ts — the day, assembled from everywhere at once.
 *
 * This is the block that makes the tutor a notebook rather than a chat
 * window. Every other context source in chatContext.ts is a *category* of
 * thing — a deck, the weak cards, the memory store. This one is a moment, and
 * it is the reason "what did I learn today?" is answerable at all:
 *
 *   · the journal source only sees entries that have been through the
 *     narrative step, so a day of raw capture was invisible;
 *   · nothing else in the app has ever put the review log into a prompt, so
 *     what was graded — and what the learner actually wrote when tested —
 *     never reached the model at all.
 *
 * Both are read here. The recall attempts are the valuable part: a grade says
 * you got it wrong, the sentence you wrote says how you were thinking, and
 * that is what a tutor would want to see.
 *
 * Three things changed when the day became the app's shared answer rather
 * than chat's private one, and they are the shape of this file:
 *
 *   **It is every section now.** It used to hold reviews, the journal, cards
 *   and memories — and miss the conversations you had, the exams you sat, the
 *   notes you logged and the figures you kept, which is four of the seven.
 *   `services/activity.ts` has read across all of them for a year; a day brief
 *   that could not was telling the model a smaller day than the calendar was
 *   drawing on the same screen.
 *
 *   **It is a window, not "today".** The journal writes up a specific day,
 *   often the one before, and handing it the current clock would have put
 *   this morning's reviews into yesterday's permanent entry.
 *
 *   **It is one record with two renderings.** `dayBlocks` is what the journal
 *   page shows you; `renderDay` is what the model is told. They are the same
 *   facts from the same walk, so the page cannot claim a day the prompt does
 *   not have — the mistake activity.ts exists to prevent, one layer up.
 *
 * Everything is capped, because this block goes out on every message.
 * ========================================================================== */
import * as store from "@/services/store";
import * as journalStore from "@/services/journalStore";
import * as memoryStore from "@/services/memoryStore";
import * as chatStore from "@/services/chatStore";
import * as examStore from "@/services/examStore";
import * as figures from "@/services/figures";
import { allVersions, keptLabel } from "@/lib/visuals/keep";
import { visualDef } from "@/lib/visuals/catalogue";
import { dayStart } from "@/lib/weeks";
import * as U from "@/lib/util";
import type { Grade } from "@/types";

const MAX_TROUBLE = 12;
const MAX_ATTEMPTS = 8;
const MAX_ITEMS = 10;
/** Conversations and exams are the cheapest lines here and the least
 *  informative per line, so they get a shorter list than the rest. */
const MAX_THREADS = 6;

/** How much of a card's back to quote. The front alone is often a bare
 *  symbol — "m", "x⁽ⁱ⁾" — which tells the model nothing about what was
 *  actually being asked, so the answer comes along with it. */
const BACK_MAX = 180;

/* -------------------------------------------------------------- windows -- */

export interface DayWindow {
  /** Inclusive. */
  from: number;
  /** Exclusive. */
  to: number;
  /** How the block names itself: "today", "over the last 7 days", "2026-3-14". */
  label: string;
  /** True when the window runs up to now, so the day is still unfinished.
   *  A closed day is written up in the past tense and does not say "so far". */
  live: boolean;
}

/** The window chat means by `today`: the last `days` calendar days, ending
 *  now. One day is midnight to this moment. */
export function todayWindow(days = 1): DayWindow {
  const n = Math.max(1, days);
  const midnight = new Date().setHours(0, 0, 0, 0);
  return {
    from: midnight - (n - 1) * U.DAY,
    to: Date.now() + 1,
    label: n === 1 ? "today" : `over the last ${n} days`,
    live: true
  };
}

/**
 * One named calendar day, midnight to midnight.
 *
 * What the journal asks for. A journal entry is written up for *its* day —
 * often yesterday, sometimes last week — so giving it a window that ends
 * "now" would file this morning's reviews under an entry dated before them,
 * permanently, in a record whose whole promise is that it is what happened.
 */
export function dayWindow(day: string): DayWindow | null {
  const start = dayStart(day);
  if (!start) return null;
  const next = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1).getTime();
  const isToday = day === U.today();
  return { from: start.getTime(), to: next, label: isToday ? "today" : day, live: isToday };
}

/* --------------------------------------------------------------- record -- */

export interface DayRecord {
  window: DayWindow;
  reviews: { total: number; clean: number; hard: number; failed: number; trouble: { grade: Grade; card: string }[] };
  /** What they wrote from memory when tested — the best evidence in here. */
  attempts: { card: string; verdict: string; wrote: string }[];
  cardsWritten: string[];
  notes: { tag: string; text: string }[];
  memories: { type: string; text: string }[];
  conversations: { id: string; title: string; turns: number; preview: string }[];
  exams: { title: string; asked: number; right: number; finished: boolean }[];
  /** Figures kept, and whether this was the first version or a later one. */
  figures: { title: string; kind: string; note: string; revised: boolean }[];
  boards: string[];
  journal: { day: string; narrative: string; learned: string[]; stuck: string[]; open: string[]; raw: string[] }[];
}

/** A logged card as "front → back", or null when the entry predates card ids
 *  or the card has since been deleted. Never throws: a brief that blew up on
 *  one stale id would take the whole send with it. */
function cardOf(deckId: string, cardId: string | undefined): string | null {
  if (!cardId) return null;
  const d = store.get().decks[deckId];
  const c = d?.cards.find((x) => x.id === cardId);
  if (!c) return null;
  const front = U.stripTags(c.q);
  const back = U.stripTags(c.a);
  if (!back) return front;
  return `${front} → ${back.length > BACK_MAX ? back.slice(0, BACK_MAX) + "…" : back}`;
}

function clip(text: string, n: number): string {
  const t = U.stripTags(text).replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

/**
 * Everything the app logged in this window, from every section.
 *
 * A set of filtered walks over lists already in memory — the same bargain
 * services/activity.ts makes, and for the same reason: this runs on the send
 * path, so it may not await anything.
 */
export function collectDay(projectId: string, window: DayWindow): DayRecord {
  const db = store.get();
  const decks = store.decksOf(projectId);
  const deckIds = new Set(decks.map((d) => d.id));
  const within = (t: number | null | undefined): boolean => typeof t === "number" && t >= window.from && t < window.to;

  /* ---- how the reviewing went ---- */
  const entries = db.log.filter((e) => within(e.t) && deckIds.has(e.d));
  const failed = entries.filter((e) => e.g === 1);
  const hard = entries.filter((e) => e.g === 2);
  const trouble = [...failed, ...hard]
    .map((e) => ({ grade: e.g, card: cardOf(e.d, e.c) }))
    .filter((x): x is { grade: Grade; card: string } => !!x.card)
    .slice(0, MAX_TROUBLE);

  const attempts = entries
    .filter((e) => e.a)
    .slice(-MAX_ATTEMPTS)
    .reverse()
    .map((e) => ({ card: cardOf(e.d, e.c) || "a card", verdict: e.v || "", wrote: String(e.a) }));

  /* ---- what they made ---- */
  const cardsWritten: string[] = [];
  for (const d of decks) for (const c of d.cards) if (within(c.created)) cardsWritten.push(U.stripTags(c.q));

  const notes = store
    .notesOf(projectId)
    .filter((n) => within(n.t))
    .slice(-MAX_ITEMS)
    .reverse()
    .map((n) => ({ tag: n.tag || "note", text: n.text }));

  const memories = memoryStore
    .list({ scope: "project", projectId, activeOnly: true })
    .filter((m) => within(m.created))
    .slice(0, MAX_ITEMS)
    .map((m) => ({ type: m.type, text: m.text }));

  /* ---- who they asked ---- */
  /* Metadata only. chatStore keeps the transcripts out of memory on purpose,
     and loading every thread to summarise a day would be an await on the send
     path — so this says which conversations were worked in and leaves what was
     said in them to the thread the learner is actually in. */
  const conversations = chatStore
    .list()
    .filter((c) => c.projectId === projectId && !c.archived && (within(c.created) || within(c.updated)))
    .slice(0, MAX_THREADS)
    .map((c) => ({ id: c.id, title: c.title, turns: c.turnCount, preview: clip(c.preview || "", 90) }));

  /* ---- what they were tested on ---- */
  const exams = examStore
    .listForProject(projectId)
    .filter((e) => within(e.created) || within(e.finishedAt) || e.questions.some((q) => within(q.answeredAt)))
    .slice(0, MAX_THREADS)
    .map((e) => {
      const marked = e.questions.filter((q) => q.result);
      return {
        title: e.title,
        asked: e.questions.length,
        right: marked.filter((q) => q.result!.verdict === "got").length,
        finished: !!e.finishedAt
      };
    });

  /* ---- what they kept ---- */
  /* Every version is its own moment (lib/visuals/keep.ts), so a canvas first
     kept last week and revised this morning belongs to this morning — which is
     the honest answer to "what did I work on today". */
  const keptToday: DayRecord["figures"] = [];
  for (const f of figures.list(projectId)) {
    const versions = allVersions(f);
    const here = versions.filter((v) => within(v.at));
    if (!here.length) continue;
    keptToday.push({
      title: f.title,
      kind: keptLabel(f.kind).toLowerCase(),
      note: f.note,
      revised: versions.length > here.length
    });
  }
  const boards = figures
    .boards(projectId)
    .filter((b) => within(b.created))
    .map((b) => b.title);

  /* ---- what they wrote down ---- */
  const journal = journalStore
    .listForProject(projectId)
    .filter((e) => {
      const w = dayWindow(e.day);
      /* By the entry's own day where it has one, so a journal written up late
         at night still belongs to the day it is about. Timestamps are the
         fallback for an entry whose key will not parse. */
      return w ? w.from >= window.from && w.from < window.to : within(e.created) || within(e.updated);
    })
    .slice(0, 2)
    .map((e) => ({
      day: e.day,
      narrative: e.summary?.narrative || "",
      learned: e.summary?.learned || [],
      stuck: e.summary?.stuck || [],
      open: e.summary?.open || [],
      /* Raw captures matter precisely because they have not been through the
         narrative step. Without this, a day of writing stays invisible until
         the learner remembers to press a button. */
      raw: e.summary ? [] : e.raw.slice(-MAX_ITEMS).map((r) => r.text)
    }));

  return {
    window,
    reviews: {
      total: entries.length,
      clean: entries.length - failed.length - hard.length,
      hard: hard.length,
      failed: failed.length,
      trouble
    },
    attempts,
    cardsWritten,
    notes,
    memories,
    conversations,
    exams,
    figures: keptToday,
    boards,
    journal
  };
}

/**
 * The day in one line of counts — "23 cards reviewed · 2 conversations".
 *
 * Deliberately not a total. A single number says a day was busy; this says
 * what kind of day it was, which is the only version worth putting on a
 * button. Lives here rather than in either component that shows it, because
 * the journal page and the chat starter must not disagree about the day.
 */
export function daySummary(r: DayRecord): string {
  const counts: [number, string, string][] = [
    [r.reviews.total, "card reviewed", "cards reviewed"],
    [r.conversations.length, "conversation", "conversations"],
    [r.exams.length, "exam", "exams"],
    [r.cardsWritten.length, "card written", "cards written"],
    [r.notes.length, "note", "notes"],
    [r.figures.length + r.boards.length, "figure kept", "figures kept"],
    [r.memories.length, "memory saved", "memories saved"]
  ];
  return counts
    .filter(([n]) => n > 0)
    .map(([n, one, many]) => `${n} ${n === 1 ? one : many}`)
    .join(" · ");
}

export function isEmptyDay(r: DayRecord): boolean {
  return (
    !r.reviews.total &&
    !r.cardsWritten.length &&
    !r.notes.length &&
    !r.memories.length &&
    !r.conversations.length &&
    !r.exams.length &&
    !r.figures.length &&
    !r.boards.length &&
    !r.journal.length
  );
}

/* ------------------------------------------------------------- rendering -- */

/** One heading and its lines. The journal page draws these; renderDay joins
 *  them into the prompt. Two renderings, one walk — so what the page shows you
 *  and what the model is told cannot disagree. */
export type DayBlockKind =
  | "reviews"
  | "attempts"
  | "conversations"
  | "exams"
  | "journal"
  | "notes"
  | "cards"
  | "figures"
  | "memories";

export interface DayBlock {
  /** What this block is, so a caller can leave one out without matching on
   *  the wording of a prompt — the journal page drops "journal", since it
   *  renders the entry itself immediately underneath. */
  kind: DayBlockKind;
  head: string;
  lines: string[];
}

export interface RenderDayOpts {
  /** Leave this conversation out of the day's list of conversations. The
   *  thread being sent is the one the model is already reading; describing it
   *  back in the system prompt is a second, staler account of it. */
  exceptConversation?: string;
}

/**
 * Ordered the way a tutor would ask: what did you struggle with, what did you
 * say, who did you ask, what were you tested on, what did you write down,
 * what did you make, what did you keep.
 */
export function dayBlocks(r: DayRecord, opts: RenderDayOpts = {}): DayBlock[] {
  const when = r.window.label;
  const out: DayBlock[] = [];
  const threads = r.conversations.filter((c) => c.id !== opts.exceptConversation);

  if (r.reviews.total) {
    const head =
      `Reviewed ${r.reviews.total} card${r.reviews.total === 1 ? "" : "s"} ${when}: ` +
      `${r.reviews.clean} recalled cleanly, ${r.reviews.hard} with difficulty, ${r.reviews.failed} not at all.`;
    out.push({
      kind: "reviews",
      head,
      lines: r.reviews.trouble.length
        ? ["The ones that did not go well:", ...r.reviews.trouble.map((t) => `- [${t.grade === 1 ? "failed" : "hard"}] ${t.card}`)]
        : []
    });
  }

  if (r.attempts.length) {
    out.push({
      kind: "attempts",
      head:
        "What they wrote from memory when tested, in their own words. This is the best evidence you have of how " +
        "they are actually thinking:",
      lines: r.attempts.map((a) => `- The card: ${a.card}\n  They wrote${a.verdict ? ` (marked ${a.verdict})` : ""}: "${a.wrote}"`)
    });
  }

  if (threads.length) {
    out.push({
      kind: "conversations",
      head: `Worked in ${threads.length} other conversation${threads.length === 1 ? "" : "s"} ${when}:`,
      lines: threads.map(
        (c) => `- "${c.title}" (${c.turns} message${c.turns === 1 ? "" : "s"})${c.preview ? ` — last on: ${c.preview}` : ""}`
      )
    });
  }

  if (r.exams.length) {
    out.push({
      kind: "exams",
      head: `Exams ${when}:`,
      lines: r.exams.map(
        (e) => `- "${e.title}" — ${e.asked} question${e.asked === 1 ? "" : "s"}, ${e.right} answered well${e.finished ? ", finished" : ", still open"}`
      )
    });
  }

  for (const e of r.journal) {
    const lines: string[] = [];
    if (e.narrative) lines.push(e.narrative);
    if (e.learned.length) lines.push(`Learned: ${e.learned.join("; ")}.`);
    if (e.stuck.length) lines.push(`Stuck on: ${e.stuck.join("; ")}.`);
    if (e.open.length) lines.push(`Left open: ${e.open.join("; ")}.`);
    if (e.raw.length) lines.push("Not written up yet. Raw notes as they were captured:", ...e.raw.map((t) => `  · ${t}`));
    if (lines.length) out.push({ kind: "journal", head: `Their journal for ${e.day}:`, lines });
  }

  if (r.notes.length) {
    out.push({
      kind: "notes",
      head: `Logged to their insight log ${when}:`,
      lines: r.notes.map((n) => `- (${n.tag}) ${n.text}`)
    });
  }

  if (r.cardsWritten.length) {
    out.push({
      kind: "cards",
      head: `Cards written ${when} (${r.cardsWritten.length}):`,
      lines: r.cardsWritten.slice(0, MAX_ITEMS).map((q) => `- ${q}`)
    });
  }

  if (r.figures.length || r.boards.length) {
    out.push({
      kind: "figures",
      /* Kept, not merely drawn. Pressing Keep is the learner saying this one
         is worth coming back to, which is a stronger signal about what they
         are working on than anything else in this block. */
      head: `Figures they kept ${when} — they pressed Keep on these, so they mean to come back to them:`,
      lines: [
        ...r.figures.map((f) => `- [${f.kind}] "${f.title}"${f.revised ? " (a new version of one they already had)" : ""}${f.note ? ` — their note: ${f.note}` : ""}`),
        ...r.boards.map((b) => `- [whiteboard] "${b}"`)
      ]
    });
  }

  if (r.memories.length) {
    out.push({
      kind: "memories",
      head: `Committed to memory ${when}:`,
      lines: r.memories.map((m) => `- (${m.type}) ${m.text}`)
    });
  }

  return out;
}

/**
 * The day as the model is told it.
 *
 * Returns null when the day is genuinely empty — a brief full of "nothing"
 * headings teaches the model to skim the whole block.
 */
export function renderDay(r: DayRecord, opts: RenderDayOpts = {}): string | null {
  const blocks = dayBlocks(r, opts);
  if (!blocks.length) return null;
  const heading = r.window.live
    ? `The learner's day so far (${U.today()}):`
    : `What the learner did on ${r.window.label}:`;
  return (
    heading +
    "\n\n" +
    blocks.map((b) => [b.head, ...b.lines].join("\n")).join("\n\n") +
    "\n\nWhen they ask what they did or learned, answer from this — concretely, naming the actual cards and " +
    "quoting their own words back where it helps. You do have this information; never tell them you have no way " +
    "of knowing what they did."
  );
}

/**
 * The question the day is for, asked in the learner's own voice.
 *
 * Two places offer it — the starter on the empty chat screen and `/today` —
 * and they are one string because a starter and a command that promise the
 * same thing and phrase it differently produce two different answers, which
 * reads as the app being unreliable rather than as two prompts.
 */
export const ASK_ABOUT_TODAY =
  "What have I been working on today? Look at what I reviewed and got wrong, what I asked about, and anything " +
  "I kept — then tell me the one thing worth doing next, and why.";

/** The `{kind:"today"}` context source, unchanged for its callers. */
export function renderToday(projectId: string, days = 1): string | null {
  return renderDay(collectDay(projectId, todayWindow(days)));
}
