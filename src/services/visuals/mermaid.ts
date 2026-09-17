/* ============================================================================
 * mermaid.ts — a Mermaid diagram, drawn in the printing's colours.
 *
 * `securityLevel: "strict"` escapes labels and disables click bindings, which
 * is Mermaid's own setting for source it did not write; HTML labels are off so
 * the output is pure SVG with no foreignObject, which the sanitiser in svg.ts
 * would strip anyway. Loaded on the first diagram, never by the review loop.
 * ========================================================================== */
import type { FigureTheme } from "./theme";

type Mermaid = (typeof import("mermaid"))["default"];

let loading: Promise<Mermaid> | null = null;
let configured = "";
let seq = 0;

function load(): Promise<Mermaid> {
  if (!loading) {
    const p = import("mermaid").then((m) => m.default);
    loading = p;
    p.catch(() => {
      if (loading === p) loading = null;
    });
  }
  return loading;
}

export async function renderMermaid(source: string, theme: FigureTheme): Promise<string> {
  const mermaid = await load();
  const key = JSON.stringify(theme);
  if (key !== configured) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      theme: "base",
      fontFamily: theme.font,
      themeVariables: {
        darkMode: theme.dark,
        fontFamily: theme.font,
        fontSize: "14px",
        background: theme.panel,
        mainBkg: theme.surface,
        primaryColor: theme.surface,
        primaryTextColor: theme.ink,
        primaryBorderColor: theme.rule,
        secondaryColor: theme.page,
        secondaryTextColor: theme.ink,
        tertiaryColor: theme.panel,
        tertiaryTextColor: theme.ink,
        lineColor: theme.ink3,
        textColor: theme.ink,
        titleColor: theme.ink,
        nodeBorder: theme.rule,
        clusterBkg: theme.page,
        clusterBorder: theme.rule,
        edgeLabelBackground: theme.panel,
        noteBkgColor: theme.surface,
        noteTextColor: theme.ink,
        noteBorderColor: theme.rule,
        actorBkg: theme.surface,
        actorBorder: theme.rule,
        actorTextColor: theme.ink,
        actorLineColor: theme.ink3,
        signalColor: theme.ink2,
        signalTextColor: theme.ink,
        labelBoxBkgColor: theme.surface,
        labelTextColor: theme.ink,
        git0: theme.palette[0],
        pie1: theme.palette[0],
        pie2: theme.palette[1],
        pie3: theme.palette[2],
        pie4: theme.palette[3],
        pie5: theme.palette[4]
      }
    });
    configured = key;
  }
  const id = `drill-mermaid-${++seq}`;
  try {
    const { svg } = await mermaid.render(id, source.trim());
    return svg;
  } finally {
    /* A render that throws leaves its measuring element in the page. */
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
  }
}
