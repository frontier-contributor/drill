/* ============================================================================
 * chart.ts — a Vega-Lite spec, drawn live, fetching nothing.
 *
 * Charts are drawn into the page rather than as a picture, because what makes
 * them worth having — tooltips, and the sliders a function plot is for — needs
 * the live view. So the spec is held to a rule instead: every URL is refused.
 * Vega routes data files, image marks and hyperlinks through its loader's
 * `sanitize`, and that answers no to all of them, so a chart can only draw what
 * is written inside it and cannot report that it was looked at, or send what
 * is in it anywhere. `usermeta` is dropped because vega-embed reads its own
 * options out of it, and those options are this file's to set.
 * ========================================================================== */
import type { FigureTheme } from "./theme";

export interface ChartHandle {
  finalize(): void;
  toSVG(): Promise<string>;
  toPNG(): Promise<string>;
}

/**
 * Refuse a spec that reaches outside itself, before Vega ever sees it.
 *
 * The loader below already answers no to every URL, but Vega treats a data
 * file it cannot load as an empty dataset: it logs and draws nothing, so the
 * reader gets an empty chart and no idea why. This is the half that can say
 * so. A `href` channel is dropped rather than refused — it is a link on a mark,
 * which is worth losing quietly rather than losing the whole chart over.
 */
function refuseRemote(node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach(refuseRemote);
    return;
  }
  if (!node || typeof node !== "object") return;
  const o = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(o)) {
    if (key === "url" && typeof value === "string") {
      throw new Error("this chart asks for data from a URL — a figure here draws only the data written into it");
    }
    if (key === "mark" && (value === "image" || (value as { type?: string })?.type === "image")) {
      throw new Error("this chart draws an image from elsewhere, which a figure here cannot do");
    }
    if (key === "href") {
      delete o[key];
      continue;
    }
    refuseRemote(value);
  }
}

export async function renderChart(el: HTMLElement, spec: Record<string, unknown>, theme: FigureTheme): Promise<ChartHandle> {
  const [{ default: embed }, vega] = await Promise.all([import("vega-embed"), import("vega")]);
  const loader = vega.loader();
  loader.sanitize = () => Promise.reject(new Error("Charts here only draw data written into them."));

  const clean = structuredClone(spec);
  delete clean.usermeta;
  refuseRemote(clean);
  if (!("width" in clean)) clean.width = "container";
  if (!("autosize" in clean)) clean.autosize = { type: "fit-x", contains: "padding" };

  const result = await embed(el, clean as never, {
    renderer: "svg",
    actions: false,
    loader,
    tooltip: { theme: theme.dark ? "dark" : "light" },
    config: {
      background: "transparent",
      font: theme.font,
      view: { stroke: "transparent" },
      title: { color: theme.ink, anchor: "start", fontWeight: 600, fontSize: 14 },
      axis: {
        domainColor: theme.rule,
        gridColor: theme.rule,
        gridOpacity: 0.6,
        tickColor: theme.rule,
        labelColor: theme.ink2,
        titleColor: theme.ink2,
        labelFont: theme.font,
        titleFont: theme.font
      },
      legend: { labelColor: theme.ink2, titleColor: theme.ink2, labelFont: theme.font, titleFont: theme.font },
      range: { category: theme.palette },
      mark: { color: theme.accent },
      text: { color: theme.ink }
    }
  });

  return {
    finalize: () => result.finalize(),
    toSVG: () => result.view.toSVG(),
    toPNG: () => result.view.toImageURL("png", 2)
  };
}
