/* ============================================================================
 * CanvasView — a canvas running, in a frame that can reach nothing.
 *
 * The rules live in lib/visuals/srcdoc.ts; this mounts them. Two things about
 * the frame are worth saying here: it is keyed on the source so a new version
 * gets a new frame rather than a mutated one, and every message it sends is
 * checked against its own contentWindow before a single field is read. The
 * frame talks — its height, and anything it threw — and is never talked to.
 * ========================================================================== */
import { useEffect, useMemo, useRef, useState } from "react";
import { CANVAS_MESSAGE, CANVAS_SANDBOX, canvasDocument, type CanvasTheme } from "@/lib/visuals/srcdoc";

interface Props {
  source: string;
  title: string;
  theme: CanvasTheme;
  /** Counts up when Restart is pressed, to build the frame again. */
  nonce: number;
  onError: (message: string) => void;
}

const MIN_HEIGHT = 140;
const MAX_HEIGHT = 900;

export default function CanvasView({ source, title, theme, nonce, onError }: Props) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState(320);
  const doc = useMemo(() => canvasDocument(source, theme), [source, theme]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      /* Not the origin — a sandboxed frame has none to check — but the window
         itself, which no other page can forge. */
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const data = e.data as { source?: string; type?: string; height?: unknown; message?: unknown } | null;
      if (!data || data.source !== CANVAS_MESSAGE) return;
      if (data.type === "height") {
        const h = Number(data.height);
        if (Number.isFinite(h)) setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(h))));
      } else if (data.type === "error") {
        onError(String(data.message || "").slice(0, 300));
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onError]);

  return (
    <iframe
      key={`${nonce}`}
      ref={frame}
      className="vis-canvas"
      style={{ height }}
      title={title}
      sandbox={CANVAS_SANDBOX}
      referrerPolicy="no-referrer"
      allow=""
      srcDoc={doc}
    />
  );
}
