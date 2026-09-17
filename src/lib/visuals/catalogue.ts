/* ============================================================================
 * catalogue.ts — every kind of figure a reply can contain, declared once.
 *
 * The bargain services/agent/tools.ts makes for tools: one list, and everything
 * else is read off it — the paragraph that teaches a model to draw, the fence
 * the renderer looks for, the Settings row that switches it off, the stand-in
 * a card writer, a search snippet or a voice gets instead of the picture. A
 * kind added here is taught, drawn and described; nothing is spelled out twice.
 * The prompt never names a fence by hand, because a literal tool name in a
 * prompt string already outlived the tool it named once (CLAUDE.md).
 *
 * Why fenced blocks rather than tool calls: no extra request, they stream,
 * they work identically on Ollama and llama.cpp, and a reply that holds one is
 * still ordinary markdown anywhere else — GitHub draws ```mermaid itself. It is
 * also this codebase's convention (`drill-memory`, `drill-call`).
 *
 * Pure.
 * ========================================================================== */

export type VisualKind = "diagram" | "chart" | "plot" | "svg";

/** One figure found in a reply, as lib/markdown.ts hands it to the renderer. */
export interface VisualBlock {
  kind: VisualKind;
  lang: string;
  source: string;
}

export interface VisualDef {
  kind: VisualKind;
  /** Fence languages that mean this kind. The first is the one taught. */
  fences: string[];
  /** What a person calls it — the figure's corner, the Settings row. */
  label: string;
  /** The Settings row's second line. */
  blurb: string;
  /** For the model: what it is for, and what the block must contain. */
  teach: string;
  /** Said instead of the figure — to the card writer, in previews, aloud. */
  standIn: (source: string) => string;
}

export const VISUALS: VisualDef[] = [
  {
    kind: "diagram",
    fences: ["mermaid"],
    label: "Diagram",
    blurb: "Flowcharts, sequences, state machines, mind maps and timelines, drawn with Mermaid.",
    teach:
      "a diagram in Mermaid syntax — flowchart, sequenceDiagram, stateDiagram-v2, classDiagram, erDiagram, mindmap, " +
      "timeline, gantt, quadrantChart or xychart-beta. For how a process runs, how parts connect, how an idea breaks " +
      'down. Keep node labels short, and put any label with brackets, quotes or symbols in double quotes: A["f(x) = x^2"].',
    standIn: (src) => `[diagram: ${mermaidTitle(src)}]`
  },
  {
    kind: "chart",
    fences: ["vega-lite", "vegalite"],
    label: "Chart",
    blurb: "Bar, line, scatter, histogram and heatmap charts of numbers, drawn with Vega-Lite.",
    teach:
      "a chart as one complete Vega-Lite JSON spec with every data point written inline under data.values — never a " +
      "URL. For comparing numbers: bar, line, area, point, rect for heatmaps, boxplot, bin for histograms. Give it a " +
      "title and axis titles.",
    standIn: (src) => `[chart: ${jsonTitle(src) || "chart"}]`
  },
  {
    kind: "plot",
    fences: ["drill-plot"],
    label: "Function plot",
    blurb: "Graphs of functions of x, with sliders for their parameters — for seeing what a parameter does.",
    teach:
      'a graph of functions of x with a slider per parameter, as JSON: {"title":"…","x":[-5,5],"fn":["a*x^2","sigmoid(a*x)"],' +
      '"params":{"a":[0.1,3,1]}}. Each param is [min, max, start]; an optional "y":[min,max] fixes the vertical range and ' +
      '"labels" names each function. Functions may use x, the params, + - * / ^, parentheses, sin cos tan exp log sqrt abs ' +
      "sigmoid relu tanh softplus min max, pi and e. For how a function behaves and what a parameter does to it.",
    standIn: (src) => `[plot: ${jsonTitle(src) || "functions of x"}]`
  },
  {
    kind: "svg",
    fences: ["svg"],
    label: "Drawing",
    blurb: "Small labelled drawings in SVG — geometry, vectors, the shape of a network.",
    teach:
      "a small labelled drawing as self-contained SVG with a viewBox — geometry, vectors, the shape of a network — when " +
      "nothing above fits. No scripts, no links, no external images or fonts.",
    standIn: (src) => `[drawing: ${svgTitle(src) || "figure"}]`
  }
];

export const VISUAL_KINDS: VisualKind[] = VISUALS.map((v) => v.kind);

export function visualForFence(lang: string): VisualDef | undefined {
  const l = String(lang || "").trim().toLowerCase();
  return l ? VISUALS.find((v) => v.fences.includes(l)) : undefined;
}

export function visualDef(kind: VisualKind): VisualDef {
  return VISUALS.find((v) => v.kind === kind) || VISUALS[0];
}

/** The kinds in force, given the ones Settings has switched off. */
export function kindsOn(off: readonly string[] | undefined): VisualKind[] {
  return VISUAL_KINDS.filter((k) => !(off || []).includes(k));
}

/** What Settings has switched off, read back from storage without trusting it. */
export function normVisualsOff(v: unknown): VisualKind[] {
  return Array.isArray(v) ? VISUAL_KINDS.filter((k) => v.includes(k)) : [];
}

function mermaidTitle(src: string): string {
  const front = /^---\s*\n[\s\S]*?\btitle:\s*(.+)\n[\s\S]*?---/.exec(src.trim());
  if (front) return front[1].trim();
  const first = src
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("%%") && l !== "---");
  return (first || "diagram").split(/\s+/)[0].replace(/(-v\d+|-beta)$/, "");
}

function jsonTitle(src: string): string {
  try {
    const t = (JSON.parse(src) as { title?: unknown }).title;
    if (typeof t === "string") return t;
    const text = (t as { text?: unknown } | undefined)?.text;
    return typeof text === "string" ? text : "";
  } catch {
    return "";
  }
}

function svgTitle(src: string): string {
  const m = /<title>([^<]{1,80})<\/title>/i.exec(src);
  return m ? m[1].trim() : "";
}
