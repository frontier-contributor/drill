/* ============================================================================
 * conceptMap.ts — the project as a mind map, built from what is already known.
 *
 * Every branch here is something the app worked out for its own reasons: the
 * subjects memories were filed under, the memories themselves, and the
 * confusions the marker keeps recording. Nothing is asked of a model, so /map
 * costs nothing and works with no key at all — and because it is derived, a
 * confusion that stops recurring stops appearing on the map (§2.6).
 *
 * The output is a Mermaid mindmap, which means the figure renderer draws it
 * and "Open in whiteboard" turns it into shapes you can rearrange.
 *
 * Pure.
 * ========================================================================== */

export interface MapTopic {
  topic: string;
  items: string[];
}

export interface MapInput {
  project: string;
  topics: MapTopic[];
  /** Memories filed under nothing, which is most of them early on. */
  loose?: string[];
  /** What the review loop says is not understood yet. */
  gaps?: string[];
}

/** Mermaid's mindmap parser takes the text after the shape, and brackets,
 *  quotes and parentheses inside it end the node early. */
function node(text: string, max = 58): string {
  const clean = String(text || "")
    .replace(/\s+/g, " ")
    .replace(/[()[\]{}"'`]/g, "")
    .trim();
  return (clean.length > max ? `${clean.slice(0, max - 1)}…` : clean) || "…";
}

/** The first clause of a memory: a mind map wants a label, not a sentence. */
function short(text: string): string {
  const first = String(text || "").split(/(?<=[.;:])\s|\s—\s/)[0];
  return node(first, 52);
}

export function conceptMap(input: MapInput): string {
  const lines = ["mindmap", `  root((${node(input.project || "This project", 40)}))`];

  for (const t of input.topics) {
    if (!t.topic) continue;
    lines.push(`    ${node(t.topic, 40)}`);
    for (const item of t.items.slice(0, 6)) lines.push(`      ${short(item)}`);
  }

  const loose = (input.loose || []).slice(0, 6);
  if (loose.length) {
    lines.push("    Unfiled");
    for (const item of loose) lines.push(`      ${short(item)}`);
  }

  const gaps = (input.gaps || []).slice(0, 6);
  if (gaps.length) {
    lines.push("    Still getting wrong");
    for (const g of gaps) lines.push(`      ${node(g, 52)}`);
  }

  return lines.join("\n");
}

/** True when there is enough to draw. One lonely root node is not a map, and
 *  showing one implies the app knows less than it does. */
export function mappable(input: MapInput): boolean {
  return (input.topics?.length || 0) + (input.loose?.length || 0) + (input.gaps?.length || 0) > 0;
}
