/* ============================================================================
 * segment.ts — a rendered reply, as the sentences a voice reads.
 *
 * Read off the rendered DOM rather than the markdown source, on the rule the
 * reply's contents list in MessageTurn already follows: the sentences a voice
 * reads and the sentences the page highlights come from the same query over
 * the same tree, so they cannot drift apart. The markdown source would need a
 * second parser that agreed with marked about every list, table and fence.
 *
 * Each sentence carries a DOM Range, used only to paint the highlight and
 * never stored: the player keeps spoken text and nothing else, and a turn
 * that mounts again simply segments itself again. The ranges point into
 * markup React owns, but only as positions — nothing here changes a node.
 *
 * Maths is read from the `data-tex` lib/markdown.ts stamps on each KaTeX root,
 * because KaTeX's HTML output keeps no copy of the source; a code block is
 * announced and skipped.
 * ========================================================================== */
import { MAX_SPOKEN, codeCue, finishSentence, sentenceSpans, speakable, splitSpoken, texToWords } from "./words";

export interface ReadSentence {
  /** What the voice is given. */
  spoken: string;
  /** Where it sits on the page. */
  range: Range;
}

const BLOCK = new Set([
  "P", "DIV", "LI", "UL", "OL", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "PRE", "TABLE", "THEAD",
  "TBODY", "TFOOT", "TR", "HR", "DL", "DT", "DD", "SECTION", "DETAILS", "SUMMARY", "FIGURE", "FIGCAPTION", "NAV"
]);

const SKIP = new Set(["BUTTON", "SCRIPT", "STYLE", "IMG", "SVG", "VIDEO", "AUDIO", "TEMPLATE", "INPUT", "TEXTAREA"]);

/** Stands in for a formula in a block's text, so sentence boundaries are
 *  found around it without its glyphs getting in the way. */
const MATH = "\uFFFC";

interface Part {
  /** Offset in the block's text. */
  at: number;
  len: number;
  /** A run of text on the page. */
  node?: Text;
  /** A formula, read as one unit. */
  el?: Element;
  tex?: string;
}

function rangeFor(parts: Part[], start: number, end: number): Range | null {
  const inside = parts.filter((p) => (p.node || p.el) && p.at < end && p.at + p.len > start);
  if (!inside.length) return null;
  const first = inside[0];
  const last = inside[inside.length - 1];
  const range = document.createRange();
  if (first.node) range.setStart(first.node, Math.max(0, start - first.at));
  else range.setStartBefore(first.el!);
  if (last.node) range.setEnd(last.node, Math.min(last.len, end - last.at));
  else range.setEndAfter(last.el!);
  return range;
}

function emit(text: string, parts: Part[], out: ReadSentence[]): void {
  for (const span of sentenceSpans(text)) {
    let raw = "";
    let from = span.start;
    for (const p of parts) {
      if (!p.el || p.at < span.start || p.at >= span.end) continue;
      raw += text.slice(from, p.at) + " " + texToWords(p.tex || "") + " ";
      from = p.at + p.len;
    }
    raw += text.slice(from, span.end);

    const said = finishSentence(speakable(raw));
    if (!/[\p{L}\p{N}]/u.test(said)) continue;
    const range = rangeFor(parts, span.start, span.end);
    if (!range) continue;
    /* A sentence too long for one request becomes several pieces that share
       its highlight — the sentence stays lit until all of it has been said. */
    for (const piece of splitSpoken(said, MAX_SPOKEN)) out.push({ spoken: piece, range });
  }
}

export function segmentReply(root: Element): ReadSentence[] {
  const out: ReadSentence[] = [];
  let parts: Part[] = [];
  let text = "";

  const flush = () => {
    if (parts.length) emit(text, parts, out);
    parts = [];
    text = "";
  };

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node as Text;
      const v = t.nodeValue || "";
      if (!v) return;
      parts.push({ at: text.length, len: v.length, node: t });
      /* A newline in the markup is layout, not prose — marked leaves one
         between every table cell — and the sentence segmenter treats each as
         a hard break, which read a table one cell at a time. Swapped for a
         space, one character for one, so every offset still lands on the
         same character of the same node. */
      text += v.replace(/[\r\n]/g, " ");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const tag = el.tagName.toUpperCase();

    /* A figure is announced and skipped, the way a code block is: reading a
       diagram's shapes aloud is noise, and the prose beside it carries the
       point — which the protocol that teaches drawing insists on. */
    if (el.classList.contains("vis-slot")) {
      flush();
      const figure = document.createRange();
      figure.selectNode(el);
      out.push({ spoken: "A figure, skipped.", range: figure });
      return;
    }
    if (el.classList.contains("codeblock")) {
      flush();
      const range = document.createRange();
      range.selectNode(el);
      out.push({ spoken: codeCue(el.querySelector(".codelang")?.textContent || ""), range });
      return;
    }
    if (el.classList.contains("katex-display") || el.classList.contains("katex")) {
      const display = el.classList.contains("katex-display");
      const tex = el.getAttribute("data-tex") || el.querySelector("[data-tex]")?.getAttribute("data-tex") || "";
      if (display) flush();
      parts.push({ at: text.length, len: MATH.length, el, tex });
      text += MATH;
      if (display) flush();
      return;
    }
    if (SKIP.has(tag) || el.getAttribute("aria-hidden") === "true") return;
    if (tag === "BR") {
      parts.push({ at: text.length, len: 1 });
      text += " ";
      return;
    }

    const block = BLOCK.has(tag);
    if (block) flush();
    for (const child of Array.from(el.childNodes)) walk(child);
    /* A table row is read across: "Adam, adaptive, yes." */
    if (tag === "TD" || tag === "TH") {
      parts.push({ at: text.length, len: 2 });
      text += ", ";
    }
    if (block) flush();
  };

  for (const child of Array.from(root.childNodes)) walk(child);
  flush();
  return out;
}

/** The sentence a selection starts in, so Listen can begin where the reader
 *  has highlighted — the same gesture Make cards already answers to. 0 when
 *  nothing inside `root` is selected. */
export function sentenceAtSelection(sentences: ReadSentence[], root: Element): number {
  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  if (!sel || sel.isCollapsed || !sel.rangeCount) return 0;
  const r = sel.getRangeAt(0);
  if (!root.contains(r.startContainer)) return 0;
  for (let i = 0; i < sentences.length; i++) {
    try {
      if (sentences[i].range.comparePoint(r.startContainer, r.startOffset) <= 0) return i;
    } catch {
      /* a range in another part of the document */
    }
  }
  return 0;
}
