/* ============================================================================
 * capture.ts — the bridge to every other AI you learn with.
 *
 * START-HERE Phase 9. Plenty of learning happens in ChatGPT, Claude.ai,
 * Gemini, a course's own assistant — anywhere but here — and all of it died
 * there: the explanation that finally made it click scrolled away in a
 * conversation you will never open again, and none of it ever became a card.
 *
 * The bridge is two halves and no API call:
 *
 *   bridgePrompt()      a prompt to paste at the end of that other
 *                       conversation. It knows the project — its name, its
 *                       goal, what you keep getting wrong, the tags your cards
 *                       already use — so what comes back is aimed, and it asks
 *                       for one fenced `drill` block of JSON.
 *
 *   parseBridgeReply()  reads what you paste back. Forgiving on purpose: the
 *                       other model will wrap it, annotate it, curl the quotes
 *                       and leave trailing commas, and sometimes ignore the
 *                       format entirely and write Q:/A: pairs. Everything it
 *                       can read becomes proposals; what it had to drop, it
 *                       says. Nothing here saves anything.
 *
 * Nothing commits itself (§2.4): the journal view shows every pile for review
 * — cards through the same ProposalsBlock every card-writing surface uses,
 * memories through the tray and its autonomy policy — and records the session
 * in the day's raw log, so it is also there for the journal writer and distill.
 *
 * Pure: strings in, values out. The pasted text is untrusted and is only ever
 * handled as data; cards are cleaned by store.normCard on the way into a
 * proposal, like every other card.
 * ========================================================================== */

export interface BridgeContext {
  projectName: string;
  goals: string;
  /** Recurring mistakes, from lib/gaps — so the other AI can aim at them. */
  gaps: string[];
  /** Tags the project's cards already use, so imported cards file beside them. */
  tags: string[];
}

export const BRIDGE_MEMORY_TYPES = ["understanding", "convention", "goal", "reference", "open"] as const;
export type BridgeMemoryType = (typeof BRIDGE_MEMORY_TYPES)[number];

export interface BridgeCard {
  tag: string;
  q: string;
  a: string;
}

export interface BridgeReply {
  summary: string;
  cards: BridgeCard[];
  notes: string[];
  memories: { type: BridgeMemoryType; text: string }[];
  open: string[];
  /** Things that could not be used, in a sentence each. Shown, not hidden. */
  problems: string[];
}

export class BridgeParseError extends Error {}

const LIMITS = { cards: 40, notes: 20, memories: 12, open: 12, text: 2000, summary: 1600 };

/* ---------------------------------------------------------------- prompt -- */

export function bridgePrompt(ctx: BridgeContext): string {
  const about = [
    `I keep a study journal in an app called Drill. This conversation belongs to my project "${ctx.projectName}"` +
      (ctx.goals.trim() ? ` — ${ctx.goals.trim().replace(/\.$/, "")}.` : "."),
    ctx.gaps.length ? `Things I keep getting wrong lately: ${ctx.gaps.slice(0, 6).join("; ")}.` : "",
    ctx.tags.length ? `My flashcards are tagged ${ctx.tags.slice(0, 12).join(", ")} — reuse one of those tags where it fits.` : ""
  ]
    .filter(Boolean)
    .join(" ");

  return [
    about,
    "",
    "Look back over everything above in this conversation and write up what I learned, so Drill can import it. " +
      "Reply with one fenced code block tagged drill containing a single JSON object, and nothing after it:",
    "",
    "```drill",
    "{",
    '  "summary": "2 to 4 sentences, addressed to me: what we covered, what landed, where I got stuck",',
    '  "cards": [{ "tag": "short topic", "q": "question", "a": "answer" }],',
    '  "notes": ["an insight worth keeping, in a sentence or two"],',
    '  "memories": [{ "type": "understanding", "text": "..." }],',
    '  "open": ["a question we left unresolved"]',
    "}",
    "```",
    "",
    "Cards: 3 to 12. Each tests exactly one idea, still makes sense months from now without this conversation, and has " +
      "a short answer. Prefer what I got wrong, found surprising or had to have explained twice over what I already knew. " +
      "Write maths in LaTeX between \\( \\) or \\[ \\], and code in backticks.",
    "Memories: things worth remembering about my understanding of this subject, not facts from a textbook. type is one of " +
      "understanding (a concept that clicked, in the way I framed it), convention (notation or framing we settled on), " +
      "goal (what I am working toward), reference (a resource worth going back to), open (a question still unresolved).",
    "Leave any list empty rather than padding it."
  ].join("\n");
}

/* ----------------------------------------------------------------- parse -- */

/** Where the JSON might be, best guess first: a `drill` fence, then any
 *  fence holding an object or array, then the outermost braces and the
 *  outermost brackets in the text. The caller keeps the first that parses. */
function jsonCandidates(text: string): string[] {
  const out: string[] = [];
  const tagged = /```+\s*drill[^\n]*\n([\s\S]*?)```/i.exec(text);
  if (tagged) out.push(tagged[1]);
  for (const m of text.matchAll(/```+[^\n]*\n([\s\S]*?)```/g)) if (/^\s*[{[]/.test(m[1])) out.push(m[1]);
  /* Both spans, in the order they open. Looking only for braces took a bare
     array of cards and returned the first card inside it as the whole reply;
     looking only at whichever opens first is thrown by a stray bracket in the
     prose before the real object. */
  const spans: [number, string][] = [];
  for (const [open, close] of [["{", "}"], ["[", "]"]]) {
    const a = text.indexOf(open);
    const b = text.lastIndexOf(close);
    if (a >= 0 && b > a) spans.push([a, text.slice(a, b + 1)]);
  }
  spans.sort((x, y) => x[0] - y[0]).forEach(([, t]) => out.push(t));
  return [...new Set(out)];
}

/** The damage chat interfaces do to JSON on the way through a clipboard. Only
 *  tried after a clean parse fails, because curly quotes are legal inside a
 *  JSON string and straightening them there would break valid input. */
function repair(json: string): string {
  return json
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/^\s*\/\/.*$/gm, "");
}

function tryParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return JSON.parse(repair(json));
  }
}

function str(v: unknown, max = LIMITS.text): string {
  if (typeof v === "string") return v.trim().slice(0, max);
  if (typeof v === "number") return String(v);
  return "";
}

/** A list of strings, accepting the `{text: ...}` objects a model sometimes
 *  writes instead. */
function strings(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return typeof v === "string" && v.trim() ? [v.trim()] : [];
  return v
    .map((x) => (x && typeof x === "object" ? str((x as Record<string, unknown>).text) : str(x)))
    .filter(Boolean)
    .slice(0, max);
}

function pick(o: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined) return o[k];
  return undefined;
}

function normType(v: unknown): BridgeMemoryType {
  const s = String(v || "").toLowerCase().trim();
  return (BRIDGE_MEMORY_TYPES as readonly string[]).includes(s) ? (s as BridgeMemoryType) : "understanding";
}

/**
 * The format ignored: "Q: … A: …" pairs, which is what a model falls back to
 * when it decides a flashcard is a flashcard. Worth reading rather than
 * refusing, because the cards are most of the value.
 */
function qaPairs(text: string): BridgeCard[] {
  const out: BridgeCard[] = [];
  const re = /(?:^|\n)\s*(?:[-*\d.)]+\s*)?\**(?:Q|Question|Front)\**\s*[:.]\s*([\s\S]*?)\n\s*(?:[-*]\s*)?\**(?:A|Answer|Back)\**\s*[:.]\s*([\s\S]*?)(?=\n\s*(?:[-*\d.)]+\s*)?\**(?:Q|Question|Front)\**\s*[:.]|\n\s*\n\s*\n|$)/gi;
  for (const m of text.matchAll(re)) {
    const q = m[1].trim();
    const a = m[2].trim();
    if (q && a) out.push({ tag: "", q: q.slice(0, LIMITS.text), a: a.slice(0, LIMITS.text) });
  }
  return out.slice(0, LIMITS.cards);
}

export function parseBridgeReply(text: string): BridgeReply {
  const raw = (text || "").trim();
  if (!raw) throw new BridgeParseError("Paste the other AI's reply first.");

  const candidates = jsonCandidates(raw);
  let obj: Record<string, unknown> | null = null;
  for (const json of candidates) {
    try {
      const v = tryParse(json);
      if (v && typeof v === "object" && !Array.isArray(v)) obj = v as Record<string, unknown>;
      else if (Array.isArray(v)) obj = { cards: v };
    } catch {
      obj = null;
    }
    if (obj) break;
  }

  if (!obj) {
    const cards = qaPairs(raw);
    if (cards.length) {
      return {
        summary: "",
        cards,
        notes: [],
        memories: [],
        open: [],
        problems: ["The reply was not in Drill's format, so only its question-and-answer pairs were read."]
      };
    }
    throw new BridgeParseError(
      candidates.length
        ? "Found something shaped like JSON but could not read it. Copy the whole reply, including the ```drill block, and paste it again."
        : "No ```drill block in that. Make sure the other AI answered the prompt, and copy its whole reply."
    );
  }

  const problems: string[] = [];

  const rawCards = pick(obj, "cards", "flashcards");
  const cards: BridgeCard[] = [];
  let dropped = 0;
  for (const c of Array.isArray(rawCards) ? rawCards : []) {
    if (!c || typeof c !== "object") {
      dropped++;
      continue;
    }
    const o = c as Record<string, unknown>;
    const q = str(pick(o, "q", "question", "front"));
    const a = str(pick(o, "a", "answer", "back"));
    if (!q || !a) {
      dropped++;
      continue;
    }
    cards.push({ tag: str(pick(o, "tag", "topic"), 44), q, a });
  }
  if (dropped) problems.push(`${dropped} card${dropped === 1 ? " was" : "s were"} missing a question or an answer and left out.`);
  if (cards.length > LIMITS.cards) problems.push(`Only the first ${LIMITS.cards} cards were kept.`);

  const rawMem = pick(obj, "memories", "memory");
  const memories = (Array.isArray(rawMem) ? rawMem : [])
    .map((m) =>
      m && typeof m === "object"
        ? { type: normType((m as Record<string, unknown>).type), text: str((m as Record<string, unknown>).text) }
        : { type: "understanding" as BridgeMemoryType, text: str(m) }
    )
    .filter((m) => m.text)
    .slice(0, LIMITS.memories);

  const out: BridgeReply = {
    summary: str(pick(obj, "summary", "narrative"), LIMITS.summary),
    cards: cards.slice(0, LIMITS.cards),
    notes: strings(pick(obj, "notes", "insights"), LIMITS.notes),
    memories,
    open: strings(pick(obj, "open", "openQuestions", "open_questions"), LIMITS.open),
    problems
  };
  if (!out.summary && !out.cards.length && !out.notes.length && !out.memories.length && !out.open.length) {
    throw new BridgeParseError("The block was there, but empty. Ask the other AI to fill it in from the conversation.");
  }
  return out;
}

/** The day's record of the session, for the journal's raw log: what the
 *  journal writer and distill will read later. Cards are counted, not
 *  listed — they are in the deck, with this day as their source. */
export function journalText(r: BridgeReply, keptNotes: string[], cardCount: number): string {
  const lines: string[] = [];
  if (r.summary) lines.push(r.summary);
  if (keptNotes.length) lines.push("", "Worth keeping:", ...keptNotes.map((n) => "- " + n));
  if (r.open.length) lines.push("", "Still open:", ...r.open.map((o) => "- " + o));
  if (cardCount) lines.push("", `${cardCount} card${cardCount === 1 ? "" : "s"} proposed from it.`);
  return lines.join("\n").trim();
}
