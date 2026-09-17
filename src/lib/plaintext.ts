/* ============================================================================
 * plaintext.ts — markdown -> readable plain text.
 *
 * Split out of markdown.ts deliberately. That module pulls in KaTeX,
 * highlight.js and marked; this one is pure regex, and it is what the
 * conversation store and sidebar previews need. Keeping them apart is what
 * stops ~450KB of rendering machinery landing in the review loop's bundle.
 * ========================================================================== */
import { visualForFence } from "./visuals/catalogue";

/** Strip markdown syntax for previews, search snippets, clipboard text and
 *  anything handed to the card writer. Not a parser — it does not need to be. */
export function markdownToText(src: string): string {
  return String(src || "")
    /* A figure is described, not transcribed. The card writer, handed forty
       lines of Mermaid, writes cards about Mermaid. */
    .replace(/```([\w-]+)[^\n]*\n([\s\S]*?)```/g, (m, lang: string, body: string) => visualForFence(lang)?.standIn(body) ?? m)
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, ""))
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    // Underscore emphasis only at word boundaries, which is what GFM actually
    // means by it. A naive /_(.*?)_/ eats LaTeX subscripts — w_t becomes wt,
    // w_{t+1} becomes w{t+1} — and this text is what the card writer sees, so
    // that silently corrupts every maths card generated from a reply.
    .replace(/(?<![\w\\])_([^_\n]+)_(?!\w)/g, "$1")
    .replace(/^\s*>\s?/gm, "")
    .trim();
}
