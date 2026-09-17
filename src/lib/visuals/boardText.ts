/* ============================================================================
 * boardText.ts — a whiteboard, written out.
 *
 * A board goes to the model as a picture, which only a model that can see can
 * read, and as this: the labels, and the arrows between them as "A → B". That
 * is what makes "what is wrong with my diagram" answerable on Ollama, on a
 * text-only model, and on a day the vision model is down — the same argument
 * as the stand-ins every other figure has.
 *
 * It reads Excalidraw's element shapes and nothing else, which is why it is
 * here rather than in services/: no import of the library, so the journal, the
 * card writer and the tests can all call it.
 *
 * Pure.
 * ========================================================================== */

interface BoundElement {
  id?: unknown;
  type?: unknown;
}

/** The parts of an Excalidraw element this reads. Everything else is ignored,
 *  and an element missing all of these contributes nothing. */
export interface BoardElement {
  id?: string;
  type?: string;
  text?: string;
  label?: { text?: string };
  containerId?: string | null;
  boundElements?: BoundElement[] | null;
  startBinding?: { elementId?: string } | null;
  endBinding?: { elementId?: string } | null;
  isDeleted?: boolean;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  [key: string]: unknown;
}

const SHAPES: Record<string, string> = {
  rectangle: "box",
  diamond: "diamond",
  ellipse: "ellipse",
  image: "image",
  frame: "frame",
  line: "line",
  freedraw: "sketch"
};

function words(text: unknown): string {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The label a shape carries, whether it is bound text or its own. */
function labelOf(el: BoardElement, textByContainer: Map<string, string>): string {
  const own = words(el.label?.text) || words(el.type === "text" ? el.text : "");
  if (own) return own;
  return el.id ? textByContainer.get(el.id) || "" : "";
}

function name(el: BoardElement | undefined, textByContainer: Map<string, string>): string {
  if (!el) return "";
  const label = labelOf(el, textByContainer);
  if (label) return label;
  return SHAPES[String(el.type)] || String(el.type || "shape");
}

/**
 * The board as a few lines of text: the shapes with labels, then the arrows
 * between them, then anything written on its own.
 *
 * Reading order is top-to-bottom, left-to-right, because that is the order the
 * person who drew it would read it out — an element list is in the order they
 * happened to draw, which says nothing.
 */
export function boardToText(elements: readonly BoardElement[], title?: string): string {
  const live = (elements || []).filter((el) => el && !el.isDeleted);
  const byId = new Map<string, BoardElement>();
  for (const el of live) if (el.id) byId.set(el.id, el);

  /* Bound text is its own element pointing at the shape it sits in. */
  const textByContainer = new Map<string, string>();
  for (const el of live) {
    if (el.type === "text" && el.containerId) {
      const text = words(el.text);
      if (text) textByContainer.set(el.containerId, text);
    }
  }

  const reading = (a: BoardElement, b: BoardElement) => (a.y || 0) - (b.y || 0) || (a.x || 0) - (b.x || 0);
  const arrows = live.filter((el) => el.type === "arrow").sort(reading);
  const boundText = new Set([...textByContainer.keys()]);

  const shapes = live
    .filter(
      (el) =>
        el.type !== "arrow" &&
        !(el.type === "text" && el.containerId) &&
        el.type !== "frame" &&
        el.type !== "freedraw" &&
        el.type !== "line"
    )
    .sort(reading);

  const lines: string[] = [];
  if (title) lines.push(`Whiteboard "${words(title)}"`);

  const labelled = shapes.filter((el) => labelOf(el, textByContainer));
  const drawnOnly = live.filter((el) => el.type === "freedraw" || el.type === "line").length;

  if (labelled.length) {
    lines.push("", "What is on it:");
    for (const el of labelled) {
      const kind = el.type === "text" ? "text" : SHAPES[String(el.type)] || String(el.type);
      lines.push(`- ${labelOf(el, textByContainer)} (${kind})`);
    }
  }

  const connections = arrows
    .map((a) => {
      const from = name(a.startBinding?.elementId ? byId.get(a.startBinding.elementId) : undefined, textByContainer);
      const to = name(a.endBinding?.elementId ? byId.get(a.endBinding.elementId) : undefined, textByContainer);
      const on = labelOf(a, textByContainer);
      if (!from && !to) return on ? `- an arrow labelled "${on}", joined to nothing` : null;
      return `- ${from || "something"} → ${to || "something"}${on ? ` (${on})` : ""}`;
    })
    .filter(Boolean) as string[];

  if (connections.length) lines.push("", "Arrows:", ...connections);

  const loose = live
    .filter((el) => el.type === "text" && !el.containerId && !boundText.has(String(el.id)))
    .sort(reading)
    .map((el) => words(el.text))
    .filter(Boolean);
  if (loose.length && !labelled.some((el) => el.type === "text")) lines.push("", "Written on it:", ...loose.map((t) => `- ${t}`));

  if (drawnOnly) lines.push("", `${drawnOnly} freehand ${drawnOnly === 1 ? "stroke or line" : "strokes and lines"} with no label.`);

  if (lines.length <= 1) return `${title ? `Whiteboard "${words(title)}" — ` : ""}empty.`;
  return lines.join("\n");
}
