/* ============================================================================
 * Visual — one figure inside a reply: a diagram, a chart, a function plot, a
 * drawing or a canvas, with the few things worth doing to it.
 *
 * Mounted by MessageTurn into the slot lib/markdown.ts left where the fenced
 * block was, once the reply has finished streaming. A figure that will not
 * draw says why and offers to send that back to the model — an ordinary
 * message, so it costs what a message costs and nothing happens behind your
 * back.
 *
 * A canvas is the one kind that keeps running after it is drawn, so it has two
 * more controls than the rest: the versions of itself written earlier in the
 * thread (derived from the transcript — see lib/visuals/artifacts.ts), and a
 * restart. Its errors arrive from inside the sandbox while you watch, so they
 * sit under it rather than replacing it: a canvas that threw once is usually
 * still worth looking at.
 *
 * The printing is read at draw time, and everything draws again when it
 * changes: a night-printed picture on a day page is a dark rectangle.
 * ========================================================================== */
import { useEffect, useMemo, useRef, useState } from "react";
import * as store from "@/services/store";
import { useDrillStore } from "@/hooks/useDrillStore";
import { visualDef, type VisualBlock } from "@/lib/visuals/catalogue";
import { canvasTitle, type CanvasVersion } from "@/lib/visuals/artifacts";
import { compilePlot } from "@/lib/visuals/plot";
import { download } from "@/lib/util";
import { figureTheme } from "@/services/visuals/theme";
import { safeSvg, svgToPng } from "@/services/visuals/svg";
import type { ChartHandle } from "@/services/visuals/chart";
import CanvasView from "./CanvasView";

interface Props {
  block: VisualBlock;
  /** Every version of this canvas in the thread, oldest first. Canvas only. */
  history?: CanvasVersion[];
  onAskFix?: (message: string) => void;
  onMakeCards?: (text: string) => void;
  /** Diagrams only: the same shapes, editable, on a whiteboard. */
  onOpenBoard?: (from: { mermaid: string; title: string }) => void;
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

/** The part of a library's error a person can act on. Mermaid's run to a dozen
 *  lines of parser state. */
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

export default function Visual({ block, history, onAskFix, onMakeCards, onOpenBoard }: Props) {
  useDrillStore();
  const s = store.settings();
  const themeKey = `${s.theme}:${s.accent}`;
  const def = visualDef(block.kind);
  const live = block.kind === "chart" || block.kind === "plot";
  const isCanvas = block.kind === "canvas";

  const [view, setView] = useState<"figure" | "source">("figure");
  const [error, setError] = useState<string | null>(null);
  const [ran, setRan] = useState<string | null>(null);
  const [image, setImage] = useState<string | null>(null);
  /* Null means "the one this reply wrote", worked out once the versions are. */
  const [pinnedVersion, setPinnedVersion] = useState<number | null>(null);
  const [runNonce, setRunNonce] = useState(0);
  const figRef = useRef<HTMLElement | null>(null);
  const chartRef = useRef<HTMLDivElement | null>(null);
  const chart = useRef<ChartHandle | null>(null);
  const svgText = useRef("");

  const versions: CanvasVersion[] = useMemo(() => {
    if (!isCanvas) return [];
    if (history?.length) return history;
    return [{ id: "canvas", title: canvasTitle(block.info, block.source), source: block.source, at: 0 }];
  }, [isCanvas, history, block.info, block.source]);
  /* A figure opens on the version its own reply wrote rather than the newest.
     The paragraph above it describes that one, and a thread that revised a
     canvas three times would otherwise draw the same picture three times under
     three different explanations. The switcher still reaches the others.
     Matched on the trimmed source because the two readers of a fence disagree
     about its last newline: marked hands over the block without it, and the
     scan over the transcript keeps it. */
  const own = versions.findIndex((v) => v.source.trim() === block.source.trim());
  const at = Math.min(pinnedVersion ?? (own >= 0 ? own : versions.length - 1), Math.max(0, versions.length - 1));
  const current = versions[at];
  const source = isCanvas && current ? current.source : block.source;

  useEffect(() => {
    if (view !== "figure" || isCanvas) return;
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
  }, [block.kind, block.source, themeKey, view, live, isCanvas]);

  /* A new version, or a restart, starts from a clean slate: the last run's
     error is about code that is no longer on screen. */
  useEffect(() => setRan(null), [at, runNonce, source]);

  const canvasTheme = useMemo(() => {
    const t = figureTheme();
    return { dark: t.dark, ink: t.ink, page: t.panel, font: t.font };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeKey]);

  const base = `${def.label.toLowerCase().replace(/\s+/g, "-")}-${Date.now().toString(36)}`;

  async function save(format: "svg" | "png" | "html") {
    try {
      if (format === "html") {
        download(`${base}.html`, source, "text/html");
        return;
      }
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

  const drawn = view === "figure" && !error && (live || isCanvas || !!image);
  const askFix = (what: string) =>
    onAskFix?.(`The ${def.label.toLowerCase()} in your reply ${what}. Send the whole block again, corrected.`);

  return (
    <figure className={`vis vis-${block.kind}`} ref={figRef}>
      <div className="vis-bar">
        <span className="vis-label">{def.label}</span>
        {isCanvas && current && <span className="vis-title">{current.title}</span>}
        {isCanvas && versions.length > 1 && (
          <span className="vis-version">
            <button type="button" onClick={() => setPinnedVersion(Math.max(0, at - 1))} disabled={at === 0} aria-label="Earlier version">
              ‹
            </button>
            v{at + 1}/{versions.length}
            <button
              type="button"
              onClick={() => setPinnedVersion(Math.min(versions.length - 1, at + 1))}
              disabled={at >= versions.length - 1}
              aria-label="Later version"
            >
              ›
            </button>
          </span>
        )}
        <span className="vis-acts">
          <button type="button" className="tact" onClick={() => setView((v) => (v === "figure" ? "source" : "figure"))}>
            {view === "figure" ? "Source" : def.label}
          </button>
          <button type="button" className="tact" onClick={() => void navigator.clipboard?.writeText(source)}>
            Copy
          </button>
          {drawn && isCanvas && (
            <>
              <button type="button" className="tact" onClick={() => setRunNonce((n) => n + 1)}>
                Restart
              </button>
              <button type="button" className="tact" onClick={() => void save("html")}>
                HTML
              </button>
            </>
          )}
          {drawn && !isCanvas && (
            <>
              <button type="button" className="tact" onClick={() => void save("svg")}>
                SVG
              </button>
              <button type="button" className="tact" onClick={() => void save("png")}>
                PNG
              </button>
            </>
          )}
          {drawn && (
            <button type="button" className="tact" onClick={() => void figRef.current?.requestFullscreen?.()}>
              Full screen
            </button>
          )}
          {onOpenBoard && block.kind === "diagram" && (
            <button
              type="button"
              className="tact"
              onClick={() =>
                onOpenBoard({
                  mermaid: block.source,
                  title: def
                    .standIn(block.source, block.info)
                    .replace(/^\[|\]$/g, "")
                    .replace(/^diagram:\s*/, "")
                })
              }
            >
              Whiteboard
            </button>
          )}
          {onMakeCards && (
            <button
              type="button"
              className="tact"
              onClick={() => onMakeCards(`${def.label} from the conversation — ${def.standIn(source, block.info)}\n\n${source}`)}
            >
              Make cards
            </button>
          )}
        </span>
      </div>

      {view === "source" ? (
        <pre className="vis-source">{source}</pre>
      ) : error ? (
        <div className="vis-error" role="alert">
          <span>Could not draw this — {error}</span>
          {onAskFix && (
            <button type="button" className="btn sm" onClick={() => askFix(`did not draw: ${error}`)}>
              Ask to fix
            </button>
          )}
        </div>
      ) : isCanvas ? (
        <CanvasView source={source} title={current?.title || "Canvas"} theme={canvasTheme} nonce={runNonce} onError={setRan} />
      ) : live ? (
        <div className="vis-chart" ref={chartRef} />
      ) : image ? (
        <img className="vis-img" src={image} alt={def.standIn(block.source, block.info)} />
      ) : (
        <div className="vis-wait">Drawing…</div>
      )}

      {/* A canvas that threw is usually still worth looking at, so this sits
          under it rather than replacing it — the same argument as the "cut
          short" strip under a reply that stopped early. */}
      {isCanvas && ran && view === "figure" && (
        <div className="vis-note" role="alert">
          <span>It threw an error while running — {ran}</span>
          {onAskFix && (
            <button type="button" className="btn sm" onClick={() => askFix(`threw an error while running: ${ran}`)}>
              Ask to fix
            </button>
          )}
        </div>
      )}
    </figure>
  );
}
