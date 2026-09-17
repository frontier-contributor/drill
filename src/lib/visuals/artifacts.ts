/* ============================================================================
 * artifacts.ts — a canvas across the conversation it lives in.
 *
 * A canvas is not stored anywhere. It is the fenced block in the reply that
 * wrote it, and that is deliberate: the transcript is already the record, so
 * branching a thread, regenerating a turn, exporting to markdown and restoring
 * a backup all carry the canvas with them and none of them needed a line of
 * code. Rewriting one is a new block with the same id, so its versions are
 * simply its blocks in order — derived, never written down twice (§2.6).
 *
 * The same fact costs something on the way out: every version of a canvas sits
 * in the history that gets replayed to the model. `collapseCanvases` leaves
 * the newest of each and replaces the rest with a line, so a fifth revision
 * does not resend the first four.
 *
 * Pure.
 * ========================================================================== */

/** ```drill-canvas title="Gradient descent" id="gd" */
const CANVAS_FENCE = /```drill-canvas([^\n]*)\n([\s\S]*?)```/g;

export interface FenceAttrs {
  [key: string]: string;
}

/** Attributes off a fence's info string. Quoted values only — an unquoted one
 *  cannot hold the spaces a title needs, so there is one shape to read. */
export function parseFenceInfo(info: string): FenceAttrs {
  const out: FenceAttrs = {};
  const re = /([a-z][a-z0-9_-]*)\s*=\s*"([^"]*)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(info || ""))) out[m[1].toLowerCase()] = m[2].trim();
  return out;
}

export function slugId(text: string): string {
  return (
    String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "canvas"
  );
}

/** A canvas's id: what it was given, or its title, so a model that rewrites a
 *  canvas under the same title updates it rather than making a second one. */
export function canvasId(info: string): string {
  const attrs = parseFenceInfo(info);
  return slugId(attrs.id || attrs.title || "canvas");
}

export function canvasTitle(info: string, source: string): string {
  const attrs = parseFenceInfo(info);
  if (attrs.title) return attrs.title;
  const heading = /<h1[^>]*>([^<]{1,80})<\/h1>/i.exec(source) || /<title[^>]*>([^<]{1,80})<\/title>/i.exec(source);
  return heading ? heading[1].trim() : "Canvas";
}

export interface CanvasVersion {
  id: string;
  title: string;
  source: string;
  /** Which message it was written in, so "v2 of 3" counts in thread order. */
  at: number;
}

/** Every version of every canvas in a conversation, oldest first, by id. */
export function canvasVersions(contents: readonly string[]): Map<string, CanvasVersion[]> {
  const byId = new Map<string, CanvasVersion[]>();
  contents.forEach((text, at) => {
    CANVAS_FENCE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CANVAS_FENCE.exec(text || ""))) {
      const id = canvasId(m[1]);
      const version = { id, title: canvasTitle(m[1], m[2]), source: m[2], at };
      const list = byId.get(id);
      if (list) list.push(version);
      else byId.set(id, [version]);
    }
  });
  return byId;
}

/**
 * The history the model is sent, with superseded canvases taken out.
 *
 * Only the newest version of each canvas keeps its code; the earlier ones
 * become a line saying so. A canvas is a few hundred lines, and a thread that
 * revised one four times would otherwise carry all four on every message after
 * — paying again for versions that have already been replaced.
 */
export function collapseCanvases(contents: readonly string[]): string[] {
  const newest = new Map<string, number>();
  const versions = canvasVersions(contents);
  for (const [id, list] of versions) newest.set(id, list[list.length - 1].at);

  return contents.map((text, at) => {
    CANVAS_FENCE.lastIndex = 0;
    return (text || "").replace(CANVAS_FENCE, (whole, info: string, source: string) => {
      const id = canvasId(info);
      if (newest.get(id) === at) return whole;
      return `[canvas "${canvasTitle(info, source)}" — an earlier version, replaced further down]`;
    });
  });
}
