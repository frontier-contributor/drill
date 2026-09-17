/* ============================================================================
 * Visual — one figure inside a reply: a diagram, a chart, a function plot or a
 * drawing, with the few things worth doing to it.
 *
 * Mounted by MessageTurn into the slot lib/markdown.ts left where the fenced
 * block was, once the reply has finished streaming. A figure that will not draw
 * says why and offers to send that back to the model — an ordinary message,
 * so it costs what any message costs and nothing happens behind your back.
 *
 * The printing is read at draw time, and the figure draws again when it
 * changes: a diagram is a picture, and a night-printed picture on a day page
 * is a dark rectangle.
 * ========================================================================== */
import { useEffect, useRef, useState } from "react";
import * as store from "@/services/store";
import { useDrillStore } from "@/hooks/useDrillStore";
import { visualDef, type VisualBlock } from "@/lib/visuals/catalogue";
import { compilePlot } from "@/lib/visuals/plot";
import { download } from "@/lib/util";
import { figureTheme } from "@/services/visuals/theme";
import { safeSvg, svgToPng } from "@/services/visuals/svg";
import type { ChartHandle } from "@/services/visuals/chart";

interface Props {
  block: VisualBlock;
  onAskFix?: (message: string) => void;
  onMakeCards?: (text: string) => void;
}

function parseSpec(source: string): Record<string, unknown> {
  let j: unknown;
  try {
    j = JSON.parse(source);
  } catch {
    try {
      j = JSON.parse(source.replace(/,\s*([}\]])/g, "$1"));
    } catch (e) {
      throw new Error(`the chart is not valid JSON (${(e as Error).message})`);
    }
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("the chart is not a Vega-Lite spec object");
  return j as Record<string, unknown>;
}

/** The part of a library's error a person can act on. Mermaid's run to a
 *  dozen lines of parser state. */
function readable(e: unknown): string {
  const text = String((e as Error)?.message || e || "unknown error");
  return text.split("\n").slice(0, 2).join(" ").slice(0, 280);
}

function saveHref(name: string, href: string): void {
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => a.remove(), 1500);
}

export default function Visual({ block, onAskFix, onMakeCards }: Props) {
  useDrillStore();
  const s = store.settings();
  const themeKey = `${s.theme}:${s.accent}`;
  const def = visualDef(block.kind);
  const live = block.kind === "chart" || block.kind === "plot";

  const [view, setView] = useState<"figure" | "source">("figure");
  const [error, setError] = useState<string | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const figRef = useRef<HTMLElement | null>(null);
  const chartRef = useRef<HTMLDivElement | null>(null);
  const chart = useRef<ChartHandle | null>(null);
  const svgText = useRef("");

  useEffect(() => {
    if (view !== "figure") return;
    let alive = true;
    let url: string | null = null;
    setError(null);

    (async () => {
      const theme = figureTheme();
      if (!live) {
        const raw =
          block.kind === "diagram" ? await (await import("@/services/visuals/mermaid")).renderMermaid(block.source, theme) : block.source;
        const clean = safeSvg(raw);
        if (!alive) return;
        svgText.current = clean;
        url = URL.createObjectURL(new Blob([clean], { type: "image/svg+xml" }));
        setImage(url);
        return;
      }
      const spec = block.kind === "plot" ? compilePlot(block.source) : parseSpec(block.source);
      const { renderChart } = await import("@/services/visuals/chart");
      if (!alive || !chartRef.current) return;
      chartRef.current.replaceChildren();
      const handle = await renderChart(chartRef.current, spec, theme);
      if (!alive) {
        handle.finalize();
        return;
      }
      chart.current = handle;
    })().catch((e) => {
      if (alive) setError(readable(e));
    });

    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
      chart.current?.finalize();
      chart.current = null;
    };
  }, [block.kind, block.source, themeKey, view, live]);

  const base = `${def.label.toLowerCase().replace(/\s+/g, "-")}-${Date.now().toString(36)}`;

  async function save(format: "svg" | "png") {
    try {
      if (live) {
        if (!chart.current) return;
        if (format === "svg") download(`${base}.svg`, await chart.current.toSVG(), "image/svg+xml");
        else saveHref(`${base}.png`, await chart.current.toPNG());
        return;
      }
      if (!svgText.current) return;
      if (format === "svg") {
        download(`${base}.svg`, svgText.current, "image/svg+xml");
      } else {
        const url = URL.createObjectURL(await svgToPng(svgText.current));
        saveHref(`${base}.png`, url);
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      }
    } catch (e) {
      setError(readable(e));
    }
  }

  const drawn = view === "figure" && !error && (live || !!image);

  return (
    <figure className={`vis vis-${block.kind}`} ref={figRef}>
      <div className="vis-bar">
        <span className="vis-label">{def.label}</span>
        <span className="vis-acts">
          <button type="button" className="tact" onClick={() => setView((v) => (v === "figure" ? "source" : "figure"))}>
            {view === "figure" ? "Source" : "Figure"}
          </button>
          <button type="button" className="tact" onClick={() => void navigator.clipboard?.writeText(block.source)}>
            Copy
          </button>
          {drawn && (
            <>
              <button type="button" className="tact" onClick={() => void save("svg")}>
                SVG
              </button>
              <button type="button" className="tact" onClick={() => void save("png")}>
                PNG
              </button>
              <button type="button" className="tact" onClick={() => void figRef.current?.requestFullscreen?.()}>
                Full screen
              </button>
            </>
          )}
          {onMakeCards && (
            <button
              type="button"
              className="tact"
              onClick={() => onMakeCards(`${def.label} from the conversation — ${def.standIn(block.source)}\n\n${block.source}`)}
            >
              Make cards
            </button>
          )}
        </span>
      </div>

      {view === "source" ? (
        <pre className="vis-source">{block.source}</pre>
      ) : error ? (
        <div className="vis-error" role="alert">
          <span>Could not draw this — {error}</span>
          {onAskFix && (
            <button
              type="button"
              className="btn sm"
              onClick={() =>
                onAskFix(
                  `The ${def.label.toLowerCase()} in your last reply did not draw: ${error}. Send the whole block again, corrected.`
                )
              }
            >
              Ask to fix
            </button>
          )}
        </div>
      ) : live ? (
        <div className="vis-chart" ref={chartRef} />
      ) : image ? (
        <img className="vis-img" src={image} alt={def.standIn(block.source)} />
      ) : (
        <div className="vis-wait">Drawing…</div>
      )}
    </figure>
  );
}
