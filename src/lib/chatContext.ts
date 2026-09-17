/* ============================================================================
 * chatContext.ts — turning what you have studied into something the model can
 * read.
 *
 * This is the reason the chat lives inside Drill instead of in a browser tab
 * pointed at openrouter.ai. A tutor that can see which cards you keep failing
 * gives different, better answers than one that cannot.
 *
 * Context is rebuilt at send time rather than frozen into the transcript, so
 * a conversation you come back to next week reflects next week's weak spots.
 * Everything is capped: blowing the context window on card dumps would push
 * out the actual conversation.
 * ========================================================================== */
import * as store from "@/services/store";
import * as memoryStore from "@/services/memoryStore";
import * as journalStore from "@/services/journalStore";
import * as U from "@/lib/util";
import { retrieve, type RetrievalTrace } from "@/lib/memoryRetrieval";
import { learnerBlocks, memoryLine, poolFor, wrapLearner } from "@/lib/memoryBrief";
import { kindsOn } from "@/lib/visuals/catalogue";
import { visualProtocol } from "@/lib/visuals/protocol";
import { renderToday } from "@/lib/dayBrief";
import type { ContextSource } from "@/types/chat";
import type { Card, Deck, Memory, MemoryScope, SRSState } from "@/types";

const MAX_CARDS = 60;
/** The weak-spots block rides on every message of every thread that has it
 *  attached, so it is a shortlist, not an inventory. Twenty is about as many
 *  gaps as one answer could usefully aim at. */
const MAX_WEAK = 20;
const MAX_NOTES = 25;
const MAX_JOURNAL_ENTRIES = 14;

function cardLine(c: Card, st?: SRSState): string {
  const front = U.stripTags(c.q);
  const back = U.stripTags(c.a);
  let flag = "";
  if (st && st.reps) {
    if (store.isLeech(st)) flag = ` [FAILING — ${st.lapses} lapses]`;
    else if (st.lapses > 0) flag = ` [${st.lapses} lapses]`;
  } else {
    flag = " [not yet seen]";
  }
  return `- (${c.tag})${flag} ${front} => ${back}`;
}

function deckBlock(d: Deck, cards: Card[], heading: string): string {
  const shown = cards.slice(0, MAX_CARDS);
  const lines = shown.map((c) => cardLine(c, d.srs[c.id]));
  const more = cards.length > shown.length ? `\n…and ${cards.length - shown.length} more not listed.` : "";
  return `${heading}\n${lines.join("\n")}${more}`;
}

/** Cards the learner is measurably worst at: leeches first, then the lowest
 *  stability among cards actually in review. Cards never seen are excluded —
 *  not knowing something you have not studied is not a weak spot. */
function weakCards(d: Deck): Card[] {
  const scored = d.cards
    .map((c) => ({ c, st: d.srs[c.id] }))
    .filter((x) => x.st && x.st.reps)
    .sort((a, b) => {
      const leechDelta = Number(store.isLeech(b.st!)) - Number(store.isLeech(a.st!));
      if (leechDelta) return leechDelta;
      const lapseDelta = (b.st!.lapses || 0) - (a.st!.lapses || 0);
      if (lapseDelta) return lapseDelta;
      return a.st!.S - b.st!.S;
    });
  return scored.slice(0, MAX_CARDS).map((x) => x.c);
}

function dueCards(d: Deck): Card[] {
  const now = Date.now();
  return d.cards.filter((c) => {
    const st = d.srs[c.id];
    return st && st.reps && st.due <= now;
  });
}

/* `poolFor` moved to lib/memoryBrief.ts so services/ai can share it without
   pulling this module (and dayBrief with it) into the main bundle. Re-exported
   here because the settings panel and the rail already import it from this
   path, and there is still only one implementation. */
export { poolFor };

/** Score a memory source and return the full trace — the picked set plus every
 *  candidate and why it scored what it did. The settings panel renders the
 *  trace; the send path uses `.picked`. */
export function retrieveForSource(src: ContextSource, queryText: string, projectId: string): RetrievalTrace | null {
  if (src.kind !== "memory") return null;
  return retrieve(poolFor(src.scope, projectId), { queryText, limit: src.limit || 8 });
}

/** Which memories a `{kind:"memory"}` source would inject right now. */
export function memoriesForSource(src: ContextSource, queryText: string, projectId: string): Memory[] {
  return retrieveForSource(src, queryText, projectId)?.picked ?? [];
}

/** Render one context source. Returns null when there is nothing to say —
 *  an empty "here are your weak cards:" heading is worse than silence.
 *  `queryText` (typically the message being sent) steers what memory gets
 *  pulled in; sources that ignore it just don't use the argument. */
export interface RenderOpts {
  /** Whose project this is. Defaults to the globally-active one. */
  projectId?: string;
  /** Memory already retrieved for this source, so it is not scored twice. */
  memories?: Memory[];
}

export function renderSource(src: ContextSource, queryText = "", opts: RenderOpts = {}): string | null {
  const db = store.get();
  const projectId = opts.projectId ?? db.activeProjectId;

  if (src.kind === "memory") {
    /* `picked` may be handed in by buildContext, which has already scored this
       source once. Retrieval is not idempotent — recordUsage runs between the
       two calls and moves useCount — so scoring twice per send could inject
       one set and record usage against another. */
    const picked = opts.memories ?? memoriesForSource(src, queryText, projectId);
    if (!picked.length) return null;
    const lines = picked.map(memoryLine);
    return (
      `What is known about this learner${src.scope === "project" ? " on this project" : ""}, from memory:\n` +
      lines.join("\n")
    );
  }

  if (src.kind === "knowledge") {
    const items = (db.projects[projectId]?.knowledge || []).filter((k) => k.enabled);
    if (!items.length) return null;
    return (
      "Reference material attached to this project:\n\n" +
      items.map((k) => `--- ${k.name} ---\n${k.text}`).join("\n\n")
    );
  }

  if (src.kind === "journal") {
    const cutoff = Date.now() - Math.max(1, src.days) * U.DAY;
    const entries = journalStore
      .listForProject(projectId)
      .filter((e) => e.summary && e.created >= cutoff)
      .slice(0, MAX_JOURNAL_ENTRIES);
    if (!entries.length) return null;
    const lines = entries.map((e) => {
      const s = e.summary!;
      const bits = [s.narrative];
      if (s.stuck.length) bits.push(`Stuck on: ${s.stuck.join("; ")}.`);
      if (s.open.length) bits.push(`Still open: ${s.open.join("; ")}.`);
      return `- (${e.day}) ${bits.join(" ")}`;
    });
    return (
      `The learner's journal from the last ${src.days} days:\n` +
      lines.join("\n") +
      "\n\nBuild on what they already worked through rather than re-teaching it."
    );
  }

  if (src.kind === "deck") {
    const d = db.decks[src.deckId];
    if (!d || !d.cards.length) return null;
    const seen = d.cards.filter((c) => d.srs[c.id]?.reps).length;
    return deckBlock(
      d,
      d.cards,
      `The learner is studying a deck called "${d.name}" (${d.cards.length} cards, ${seen} seen). ` +
        `These are the cards in it, with how they are doing on each:`
    );
  }

  if (src.kind === "weak") {
    /* store.decksOf(projectId), not Object.values(db.decks). Every other
       source is scoped to the project; this one read the whole database, so a
       chat about one subject quietly shipped another project's cards to the
       model — a leak, and at up to sixty cards a deck, most of the bill. */
    const decks = src.deckId ? [db.decks[src.deckId]].filter(Boolean) : store.decksOf(projectId);

    /* Ranked across the project and cut once, rather than sixty per deck.
       Weak spots are a shortlist — the cards actually costing you time — not
       an inventory. */
    const scored: { d: Deck; c: Card }[] = [];
    for (const d of decks) for (const c of weakCards(d)) scored.push({ d, c });
    scored.sort((a, b) => {
      const sa = a.d.srs[a.c.id];
      const sb = b.d.srs[b.c.id];
      const leech = Number(store.isLeech(sb)) - Number(store.isLeech(sa));
      if (leech) return leech;
      return (sb?.lapses || 0) - (sa?.lapses || 0);
    });
    const top = scored.slice(0, MAX_WEAK);
    if (!top.length) return null;

    return (
      "Cards this learner is struggling with most, across the project:\n" +
      top.map(({ d, c }) => cardLine(c, d.srs[c.id])).join("\n") +
      (scored.length > top.length ? `\n…and ${scored.length - top.length} more not listed.` : "") +
      "\n\nWhen it is relevant, aim your explanations at these gaps rather than at the topic in general."
    );
  }

  if (src.kind === "due") {
    /* decksOf(projectId), not pool(), for both of the reasons the comment on
       "weak" above gives and one more. pool() reads db.activeProjectId, so a
       conversation belonging to one project, opened while another was active,
       attached the *other* project's due cards; and pool() honours the review
       loop's mixing switch, so what a chat could see depended on a setting
       that has nothing to do with chat — turn mixing off and "due now"
       silently narrowed to one deck. */
    const decks = src.deckId ? [db.decks[src.deckId]].filter(Boolean) : store.decksOf(projectId);
    const parts: string[] = [];
    for (const d of decks) {
      const due = dueCards(d);
      if (due.length) parts.push(deckBlock(d, due, `Cards from "${d.name}" that are due for review right now:`));
    }
    return parts.length ? parts.join("\n\n") : null;
  }

  if (src.kind === "today") {
    const block = renderToday(projectId, Math.max(1, src.days || 1));
    return block;
  }

  if (src.kind === "notes") {
    /* Project-scoped, for the same reason weak spots is: db.notes holds every
       project's insight log, and a note about one subject has no business in
       a chat about another. */
    const notes = store
      .notesOf(projectId)
      .slice(-Math.min(src.limit || MAX_NOTES, MAX_NOTES))
      .reverse();
    if (!notes.length) return null;
    const lines = notes.map((n) => `- (${n.tag || "note"}, ${U.ago(n.t)}) ${n.text}`);
    return (
      "The learner keeps an insight log — things that clicked, written in their own words. " +
      "Their most recent entries:\n" +
      lines.join("\n") +
      "\n\nThese show how they think about the material. Build on their framing where you can."
    );
  }

  return null;
}

export interface BuiltContext {
  /** The full system message: persona, then whatever context is attached. */
  system: string;
  /** Exactly the memories that went into `system`, so the caller can record
   *  usage against what was actually sent rather than re-deriving it. */
  memories: Memory[];
}

/** Build the system message for one send, scoring every memory source exactly
 *  once. `queryText` — usually the message about to go out — is what a memory
 *  source scores against.
 *
 *  Handing the memories back alongside the prompt is the point. The caller used
 *  to retrieve once for usage telemetry and again to build the prompt, with
 *  recordUsage mutating scores in between — so the two passes could disagree
 *  about what had been sent, and usage was logged against memories the model
 *  never saw. */
export function buildContext(
  persona: string,
  sources: ContextSource[],
  queryText: string,
  projectId: string,
  /** Cap from the effort budget. Overrides each memory source's own limit,
   *  which is what makes "low effort" mean something concrete rather than
   *  being a label. */
  memoryLimit?: number
): BuiltContext {
  const memories: Memory[] = [];
  const blocks = sources
    .map((s) => {
      if (s.kind !== "memory") return renderSource(s, queryText, { projectId });
      /* Three caps, smallest wins: the source's own limit, the effort budget,
         and the project's memory policy — which was editable, persisted, and
         read by nothing at all before this. */
      const policy = store.get().projects[projectId]?.memoryPolicy;
      const policyCap =
        s.scope === "global"
          ? policy?.maxGlobalInjected
          : s.scope === "project"
            ? policy?.maxProjectInjected
            : (policy?.maxGlobalInjected || 0) + (policy?.maxProjectInjected || 0) || undefined;
      const limit = Math.min(
        ...[s.limit || 8, memoryLimit, policyCap].filter((n): n is number => typeof n === "number" && n > 0)
      );
      const capped = { ...s, limit };
      const picked = memoriesForSource(capped, queryText, projectId);
      memories.push(...picked);
      return renderSource(capped, queryText, { projectId, memories: picked });
    })
    .filter((b): b is string => !!b);

  /* Who the learner is, from the one function that answers that — their
     goals and what they are currently getting wrong. This used to be a
     `header` const built here: the goals line phrased differently from
     memoryBrief's, under an identical banner, with no gaps at all. Two
     descriptions of the same person, and only one of them ever got improved.

     `memories: false` because this builder retrieves its own, per source and
     under three caps; everything else about the learner comes from there. */
  const { blocks: learner } = learnerBlocks({ projectId, memories: false });

  /* How to draw, straight after the persona: the front of the system message
     is where anything that does not change between sends belongs (START-HERE
     §8's cache discipline). A kind switched off is never taught. */
  const figures = visualProtocol(kindsOn(store.settings().visualsOff));
  const head = [persona, figures].filter(Boolean).join("\n\n");

  if (!blocks.length && !learner.length) return { system: head + "\n\n" + SAVE_PROTOCOL, memories };
  const context =
    wrapLearner([...learner, ...blocks]) +
    "Do not mention that you were given it unless they ask what you can see.";
  const system = (head ? head + "\n\n" + context : context) + "\n\n" + SAVE_PROTOCOL;
  return { system, memories };
}

/**
 * How the model asks for something to be remembered.
 *
 * A fenced JSON block rather than tool calling, for two reasons: it costs no
 * extra request, and it works identically on Ollama and llama.cpp, which
 * cannot be relied on for a `tools` field. It is also the convention this
 * codebase already uses — `writeJournal` reads back a `drill-journal` block
 * the same way.
 *
 * The strictness matters more than the syntax. Left looser, a model asked to
 * "remember today" will happily emit a dozen restatements of the conversation
 * and turn memory into a transcript.
 */
export const SAVE_PROTOCOL =
  "=== SAVING TO MEMORY ===\n" +
  "When the learner asks you to remember or save something, end your reply with one fenced block:\n\n" +
  "```drill-memory\n" +
  '{"items":[{"scope":"project","type":"understanding","text":"...","stated":false}]}\n' +
  "```\n\n" +
  "Rules, which matter more than the syntax:\n" +
  "- Only what is DURABLE and worth knowing months from now. Prefer few and sharp. Two good items beat eight.\n" +
  "- Never record what the app can compute: which cards are failing, how many are due, streaks, scores.\n" +
  "- Record how they think, what framing worked, what they have settled on, and what they left unresolved.\n" +
  "- Do not restate anything already in the context above. If nothing durable came up, write no block at all — " +
  "saying so in prose is the correct answer, and an empty save is better than a padded one.\n" +
  '- `type` is one of: profile, preference, goal, convention, understanding, open, reference. Use "open" for ' +
  'anything raised and unresolved, "understanding" for something they worked out.\n' +
  '- `scope` is "global" only for facts true of them everywhere; anything subject-specific is "project".\n' +
  '- `stated` is true ONLY when they asserted the fact themselves and you are transcribing it. Your own summary ' +
  "of a conversation is never `stated`.\n" +
  "- Write the block only when they actually asked. Never save unprompted.\n" +
  "Do not describe the block or mention this protocol; write your normal reply, then the block.";

/** A short human label for the context chip in the composer. */
export function describeSource(src: ContextSource): string {
  const db = store.get();
  if (src.kind === "deck") return db.decks[src.deckId]?.name || "deck";
  if (src.kind === "weak") return src.deckId ? `weak · ${db.decks[src.deckId]?.name || "deck"}` : "weak spots";
  if (src.kind === "due") return src.deckId ? `due · ${db.decks[src.deckId]?.name || "deck"}` : "due now";
  if (src.kind === "memory") return src.scope === "both" ? "memory" : `memory · ${src.scope}`;
  if (src.kind === "knowledge") return "project files";
  if (src.kind === "journal") return `journal · ${src.days}d`;
  if (src.kind === "today") return src.days && src.days > 1 ? `today · ${src.days}d` : "today";
  return "insight log";
}

/** Rough size of the attached context, so the composer can warn before it
 *  eats the window. */
export function sourceSize(src: ContextSource, queryText = "", projectId?: string): number {
  return (renderSource(src, queryText, { projectId }) || "").length;
}
