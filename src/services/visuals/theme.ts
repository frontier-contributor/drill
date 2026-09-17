/* ============================================================================
 * theme.ts — the printing's colours, in a form a chart library can read.
 *
 * Every colour in the app is an oklch() token. Mermaid computes shades of the
 * colours it is given with a library that reads hex and rgb, and Vega blends
 * palettes the same way, so a token handed over as written is either ignored
 * or throws. This reads each token as the page currently resolves it and
 * paints it into a one-pixel canvas to get the sRGB the browser would show —
 * the tokens stay the only place a colour is decided.
 * ========================================================================== */

export interface FigureTheme {
  dark: boolean;
  page: string;
  panel: string;
  surface: string;
  ink: string;
  ink2: string;
  ink3: string;
  rule: string;
  accent: string;
  palette: string[];
  /** A system font stack. Mermaid measures label widths with the page's fonts
   *  and the finished drawing is shown as an image, which cannot use the
   *  page's web fonts — both have to agree on a face that is always there. */
  font: string;
}

let probe: CanvasRenderingContext2D | null = null;

function toHex(css: string, fallback: string): string {
  try {
    if (!probe) {
      const c = document.createElement("canvas");
      c.width = 1;
      c.height = 1;
      probe = c.getContext("2d", { willReadFrequently: true });
    }
    if (!probe || !css) return fallback;
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = fallback;
    probe.fillStyle = css;
    probe.fillRect(0, 0, 1, 1);
    const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
    return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
  } catch {
    return fallback;
  }
}

export function figureTheme(): FigureTheme {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const dark = root.dataset.theme !== "day";
  const read = (name: string, fallback: string) => toHex(style.getPropertyValue(name).trim(), fallback);
  const ink = read("--ink", dark ? "#f0ebe3" : "#2f2a24");
  return {
    dark,
    page: read("--page", dark ? "#26221e" : "#f7f4ee"),
    panel: read("--page-2", dark ? "#1f1c19" : "#efe9df"),
    surface: read("--surface-2", dark ? "#39342f" : "#f1ece3"),
    ink,
    ink2: read("--ink-2", ink),
    ink3: read("--ink-3", ink),
    rule: read("--rule", dark ? "#46403a" : "#d6cfc3"),
    accent: read("--accent", "#4f7cff"),
    palette: ["--accent", "--green", "--amber", "--red", "--violet", "--ink-2"].map((n) => read(n, ink)),
    font: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
  };
}
