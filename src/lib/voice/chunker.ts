/* ============================================================================
 * chunker.ts — a reply that is still being written, as things to say.
 *
 * Reading a finished reply aloud (lib/speech/segment.ts) can walk the rendered
 * page. Voice mode cannot wait for the page: the whole point is to start
 * talking while the model is still writing, so this reads raw markdown as it
 * streams and hands out a sentence the moment one is finished — and never the
 * same sentence twice, however many times the growing text is pushed in.
 *
 * What it will not say:
 *
 *   Code, figures and tables. They go on screen in the thread; the voice says
 *   one line naming them instead — "I've put the Python code on screen" — once
 *   per block, never once per line. The names come from the figure catalogue
 *   and the code-language table, not from a list typed here.
 *
 *   The app's own protocol. A `drill-` fence that is not a figure is a tool
 *   call or a memory note meant for the app, and a voice reading it out would
 *   be reading the plumbing.
 *
 * What it does to be quick: the very first thing said may be a clause rather
 * than a sentence — "Sure, so a gradient is" goes to the voice at the comma
 * rather than waiting for the full stop. The first clip is what the silence
 * before the answer is measured to, and a clause is most of a second sooner.
 *
 * Every chunk carries `rawEnd`, how far into the markdown it reaches, so an
 * interrupted reply can be cut back to what was actually said (`cutReply`).
 *
 * Pure. chunker.test.ts holds the rules.
 * ========================================================================== */

import { codeName, finishSentence, sentenceSpans, speakable, splitSpoken, texToWords, MAX_SPOKEN } from "@/lib/speech/words";
import { visualForFence } from "@/lib/visuals/catalogue";

export interface SpokenChunk {
  text: string;
  /** Offset into the reply's markdown that this chunk has reached. */
  rawEnd: number;
  /** Which run of the reply it came from. The agent loop throws away what it
   *  streamed before a tool call, and a chunk from that run points into text
   *  that no longer exists. */
  gen: number;
  /** A line standing in for something on screen, not the reply's own words. */
  cue?: string;
}

/** The first clip may be cut at a clause once there is this much of it. */
const FIRST_CLAUSE = 44;

const FENCE = /^\s{0,3}(```+|~~~+)\s*([^\s`]*)(.*)$/;
const BLOCK_START = /^\s{0,3}(#{1,6}\s+|[-*+]\s+|\d{1,3}[.)]\s+|>\s?)/;
const NO_BREAK_BEFORE = /\b(?:e\.g|i\.e|etc|vs|cf|approx|fig|eq|no|dr|mr|mrs|ms|prof|st)\.$/i;

/** Markdown to what a voice should be handed. */
function clean(s: string): string {
  return speakable(
    s
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/\[\d+(?:\s*,\s*\d+)*\]/g, " ")
      .replace(/<\/?[a-z][^>]*>/gi, " ")
      .replace(/\$\$([\s\S]+?)\$\$/g, (_, t: string) => " " + texToWords(t) + " ")
      .replace(/\\\[([\s\S]+?)\\\]/g, (_, t: string) => " " + texToWords(t) + " ")
      .replace(/\\\(([\s\S]+?)\\\)/g, (_, t: string) => " " + texToWords(t) + " ")
      .replace(/\$([^$\n]+?)\$/g, (_, t: string) => " " + texToWords(t) + " ")
      .replace(/`([^`]+)`/g, "$1")
  );
}

/** What is said for a fenced block, or "" for one that is never mentioned. */
function fenceCue(lang: string): string {
  const visual = visualForFence(lang);
  if (visual) return `I've put a ${visual.label.toLowerCase()} on screen.`;
  if (/^drill-/i.test(lang)) return "";
  const name = codeName(lang);
  return name ? `I've put the ${name} code on screen.` : "I've put some code on screen.";
}

const TABLE_CUE = "I've put a table on screen.";

/** The last place in `tail` where a sentence certainly ended: terminal
 *  punctuation, then space. Not inside inline code or maths, and not after
 *  an abbreviation. -1 when there is none yet. */
function safeCut(tail: string): number {
  const re = /[.!?…]+["')\]*_]*\s+/g;
  let best = -1;
  for (let m = re.exec(tail); m; m = re.exec(tail)) {
    const end = m.index + m[0].length;
    const head = tail.slice(0, end);
    if ((head.match(/`/g) || []).length % 2) continue;
    if ((head.replace(/\\\$/g, "").match(/\$/g) || []).length % 2) continue;
    if (NO_BREAK_BEFORE.test(tail.slice(0, m.index + 1))) continue;
    best = end;
  }
  return best;
}

export class Chunker {
  private raw = "";
  private pos = 0;
  private gen = 0;
  private fence: string | null = null;
  private inTable = false;
  private inMath = false;
  private math = "";
  private atLineStart = true;
  /** The line being read opened with a heading or list marker, so its end is
   *  a sentence end even without a full stop. */
  private lineIsBlock = false;
  private pending = "";
  private pendingStart = 0;
  private said = 0;
  private lastCue = "";

  /** The reply as it stands. Returns what has newly become sayable. */
  push(acc: string): SpokenChunk[] {
    if (acc.length < this.pos || acc.slice(0, this.pos) !== this.raw.slice(0, this.pos)) this.restart();
    this.raw = acc;
    const out: SpokenChunk[] = [];

    for (let nl = acc.indexOf("\n", this.pos); nl >= 0; nl = acc.indexOf("\n", this.pos)) {
      const line = acc.slice(this.pos, nl);
      const fromStart = this.atLineStart;
      const start = this.pos;
      this.pos = nl + 1;
      this.line(line, fromStart, start, out);
      this.atLineStart = true;
    }

    /* The unfinished last line: only ever prose, and only up to the last
       sentence that has certainly ended. A line that might still turn out to
       be a fence, a table or a list marker is left until it can be read. */
    if (!this.fence && !this.inMath && !this.inTable) {
      const tail = acc.slice(this.pos);
      const undecided = this.atLineStart && (/^\s*(`|~|\||\$\$)/.test(tail) || tail.trim().length < 3);
      if (!undecided) {
        const cut = safeCut(tail);
        if (cut > 0) {
          let seg = tail.slice(0, cut);
          if (this.atLineStart) {
            this.lineIsBlock = BLOCK_START.test(seg);
            seg = seg.replace(BLOCK_START, "");
          }
          this.add(seg, this.pos);
          this.pos += cut;
          this.atLineStart = false;
        } else if (this.said === 0 && !this.pending) {
          this.firstClause(tail, out);
        }
      }
    }
    this.drain(out, false);
    return out;
  }

  /** The reply is complete: everything left is said. */
  finish(): SpokenChunk[] {
    const out: SpokenChunk[] = [];
    if (!this.fence && !this.inTable && !this.inMath) {
      const tail = this.raw.slice(this.pos);
      if (tail.trim()) {
        this.add(this.atLineStart ? tail.replace(BLOCK_START, "") : tail, this.pos);
        this.pos = this.raw.length;
      }
    }
    this.drain(out, true);
    return out;
  }

  /** Where the text being said now came from, for cutting an interrupted reply. */
  get generation(): number {
    return this.gen;
  }

  private restart(): void {
    this.gen++;
    this.pos = 0;
    this.fence = null;
    this.inTable = false;
    this.inMath = false;
    this.math = "";
    this.atLineStart = true;
    this.lineIsBlock = false;
    this.pending = "";
    this.pendingStart = 0;
    this.said = 0;
    this.lastCue = "";
  }

  /** One whole line. `this.pos` is already past it; `start` is where it began. */
  private line(line: string, fromStart: boolean, start: number, out: SpokenChunk[]): void {
    const t = line.trim();

    if (this.fence) {
      if (t.startsWith(this.fence)) this.fence = null;
      return;
    }
    if (this.inMath) {
      if (t.endsWith("$$") || t.endsWith("\\]")) {
        this.math += " " + t.replace(/(\$\$|\\\])$/, "");
        this.inMath = false;
        this.add(" " + texToWords(this.math) + " ", start);
      } else this.math += " " + t;
      return;
    }

    const open = fromStart ? FENCE.exec(line) : null;
    if (open) {
      this.drain(out, true);
      this.fence = open[1].slice(0, 3);
      this.cue(fenceCue(open[2]), out);
      return;
    }
    if (fromStart && t.startsWith("|")) {
      if (!this.inTable) {
        this.drain(out, true);
        this.inTable = true;
        this.cue(TABLE_CUE, out);
      }
      return;
    }
    this.inTable = false;

    if (fromStart && (t === "$$" || t === "\\[" || ((t.startsWith("$$") || t.startsWith("\\[")) && !/(\$\$|\\\])$/.test(t.slice(2))))) {
      this.inMath = true;
      this.math = t.slice(2);
      return;
    }
    if (!t) {
      this.drain(out, true);
      return;
    }
    if (fromStart && (/^(-{3,}|\*{3,}|_{3,})$/.test(t) || /^!\[/.test(t))) {
      this.drain(out, true);
      return;
    }

    let text = line;
    if (fromStart) {
      this.lineIsBlock = BLOCK_START.test(line);
      text = line.replace(BLOCK_START, "");
    }
    this.add(text, start);
    /* A heading or a list item ends where its line does. A paragraph line
       ends a sentence only if it says so itself. */
    if (this.lineIsBlock) {
      this.pending = finishSentence(this.pending);
      this.drain(out, true);
    }
    this.lineIsBlock = false;
  }

  /** Prose that began at raw offset `start`, onto what is waiting to be said. */
  private add(markdown: string, start: number): void {
    const c = clean(markdown);
    if (!this.pending) this.pendingStart = start;
    if (c) this.pending = this.pending ? this.pending + " " + c : c;
  }

  private cue(text: string, out: SpokenChunk[]): void {
    if (!text || text === this.lastCue) return;
    this.lastCue = text;
    this.said++;
    out.push({ text, rawEnd: this.pos, gen: this.gen, cue: text });
  }

  /** Say the finished sentences in `pending` — all of them when `final`. */
  private drain(out: SpokenChunk[], final: boolean): void {
    if (!this.pending.trim()) {
      this.pending = "";
      return;
    }
    const spans = sentenceSpans(this.pending);
    /* Text only ever reaches `pending` up to a boundary that is certain — a
       line end, or punctuation already followed by a space — so a last
       sentence that ends in a full stop is finished, not waiting for more. */
    const closed = /[.!?…]["')\]]*$/.test(this.pending.trimEnd());
    const take = final || closed ? spans.length : spans.length - 1;
    if (take <= 0) {
      if (final) this.pending = "";
      return;
    }
    const total = this.pending.length;
    const span = this.pos - this.pendingStart;
    for (let i = 0; i < take; i++) {
      const s = this.pending.slice(spans[i].start, spans[i].end);
      const rawEnd = this.pendingStart + Math.round((span * spans[i].end) / total);
      for (const piece of splitSpoken(s, MAX_SPOKEN)) {
        if (!/[\p{L}\p{N}]/u.test(piece)) continue;
        this.said++;
        this.lastCue = "";
        out.push({ text: piece, rawEnd, gen: this.gen });
      }
    }
    if (final || take >= spans.length) {
      this.pending = "";
      this.pendingStart = this.pos;
    } else {
      const from = spans[take].start;
      this.pendingStart += Math.round((span * from) / total);
      this.pending = this.pending.slice(from);
    }
  }

  /** Before anything has been said: hand over the first clause as soon as
   *  one is long enough, rather than waiting for the sentence to end. */
  private firstClause(tail: string, out: SpokenChunk[]): void {
    const body = this.atLineStart ? tail.replace(BLOCK_START, "") : tail;
    if (body.length < FIRST_CLAUSE) return;
    const re = /[,;:—–](?=\s)/g;
    let cut = -1;
    for (let m = re.exec(body); m; m = re.exec(body)) {
      if (m.index >= 20) {
        cut = m.index + 1;
        break;
      }
    }
    if (cut < 0) return;
    const head = body.slice(0, cut);
    if ((head.match(/`/g) || []).length % 2 || (head.match(/\$/g) || []).length % 2) return;
    const text = clean(head);
    if (!/[\p{L}\p{N}]/u.test(text)) return;
    const consumed = tail.length - body.length + cut;
    this.pos += consumed;
    this.atLineStart = false;
    this.said++;
    out.push({ text, rawEnd: this.pos, gen: this.gen });
  }
}

/**
 * An interrupted reply, cut back to what was said.
 *
 * `rawEnd` is the chunk that was playing when it was talked over. The cut
 * never lands inside a fenced block: a block that was on screen when the
 * interruption came was seen whole, so it stays whole.
 */
export function cutReply(reply: string, rawEnd: number): string {
  let end = Math.max(0, Math.min(reply.length, rawEnd));
  const fences = /^\s{0,3}(```|~~~)/gm;
  let open = false;
  let openedAt = 0;
  for (let m = fences.exec(reply); m && m.index < end; m = fences.exec(reply)) {
    open = !open;
    openedAt = m.index;
  }
  if (open) {
    fences.lastIndex = openedAt + 3;
    const close = fences.exec(reply);
    if (!close) end = reply.length;
    else {
      const nl = reply.indexOf("\n", close.index);
      end = nl < 0 ? reply.length : nl;
    }
  }
  const kept = reply.slice(0, end).trimEnd();
  return end < reply.trimEnd().length ? kept + " …" : kept;
}
