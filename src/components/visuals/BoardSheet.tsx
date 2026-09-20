/* ============================================================================
 * BoardSheet — the whiteboard, over whatever it was opened from.
 *
 * Excalidraw is loaded on demand (services/boards/library.ts) and mounted in a
 * sheet rather than in a pane: a pane is a review dialog in this codebase, and
 * a board opens from chat and from the Figures section, neither of which is
 * the review loop.
 *
 * `onSend` is optional because of that second caller. From a conversation
 * there is somewhere to send the board; from the shelf there is not, and a
 * button that would have to invent a thread to send it to is worse than no
 * button — you open the board from chat when sending it is what you wanted.
 *
 * Three things here are rules rather than choices:
 *
 *   A board saves itself, on a timer, through the write guard. Nothing about
 *   drawing suggests "now save", so a board that needed a button would be lost
 *   work the first time someone closed the tab — the same argument settings
 *   make for committing on blur.
 *
 *   `validateEmbeddable={false}` and `onLinkOpen` intercepted. Excalidraw can
 *   embed a frame from a list of sites it trusts and open links a shape
 *   carries; neither is something a drawing surface inside this app should do
 *   on its own, and the model can write elements.
 *
 *   Sending it to chat sends two things: the picture, for a model that can
 *   see, and the board read out (lib/visuals/boardText.ts) for one that
 *   cannot. Asking "what is wrong with this" then works on every backend.
 * ========================================================================== */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as store from "@/services/store";
import { useDrillStore } from "@/hooks/useDrillStore";
import * as boards from "@/services/boards";
import { excalidraw } from "@/services/boards/library";
import { ingest } from "@/services/files/ingest";
import type { BoardElement } from "@/lib/visuals/boardText";
import type { Attachment } from "@/types/chat";
import Icon from "../ui/Icon";

const SAVE_AFTER = 900;

interface Props {
  board: boards.StoredBoard;
  /** Sends the board as a message: a picture, and the board read out. Absent
   *  when the board was not opened from a conversation. */
  onSend?: (text: string, attachments: Attachment[]) => void;
  /** Throws the board away. Absent where there is no list to throw it out of. */
  onDelete?: () => void;
  onClose: () => void;
}

type Scene = { elements: BoardElement[]; files: Record<string, unknown> };

export default function BoardSheet({ board, onSend, onDelete, onClose }: Props) {
  useDrillStore();
  const dark = store.settings().theme !== "day";

  const [Board, setBoard] = useState<{ Excalidraw: React.ComponentType<Record<string, unknown>> } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [title, setTitle] = useState(board.title);
  const [busy, setBusy] = useState<string | null>(null);
  const [saved, setSaved] = useState<number>(board.updated);

  /* The live scene, kept in a ref rather than state: it changes on every
     pointer move, and re-rendering the surface on each one would fight the
     surface for the frame. */
  const scene = useRef<Scene>({ elements: (board.elements || []) as BoardElement[], files: (board.files || {}) as Record<string, unknown> });
  const timer = useRef<number>(0);
  const dirty = useRef(false);

  const initial = useMemo(
    () => ({
      elements: board.elements as never,
      files: (board.files || {}) as never,
      appState: { viewBackgroundColor: dark ? "#1b1b1f" : "#ffffff", ...(board.view || {}) } as never,
      scrollToContent: true
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [board.id]
  );

  useEffect(() => {
    let alive = true;
    excalidraw().then(
      (lib) => alive && setBoard({ Excalidraw: lib.Excalidraw as unknown as React.ComponentType<Record<string, unknown>> }),
      (e) => alive && setFailed(String((e as Error)?.message || e))
    );
    return () => {
      alive = false;
    };
  }, []);

  const commit = useCallback(async () => {
    if (!dirty.current) return;
    dirty.current = false;
    const clean = boards.safeScene({ elements: scene.current.elements, files: scene.current.files });
    const ok = await boards.save({
      ...board,
      title: title.trim() || "Whiteboard",
      elements: clean.elements,
      files: clean.files,
      updated: Date.now()
    });
    if (ok) setSaved(Date.now());
  }, [board, title]);

  /* The timer handle is cleared as well as cancelled: StrictMode mounts,
     cleans up and mounts again, and a stale non-zero handle would make the
     second mount think a save was already scheduled. */
  useEffect(
    () => () => {
      if (timer.current) {
        window.clearTimeout(timer.current);
        timer.current = 0;
      }
      void commit();
    },
    [commit]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      /* Only when the drawing surface does not want it: Escape inside
         Excalidraw closes its own menus and clears a selection first. */
      if (e.key === "Escape" && !document.querySelector(".excalidraw .Island, .excalidraw .popover")) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  function onChange(elements: readonly unknown[], _state: unknown, files: unknown) {
    scene.current = { elements: elements as BoardElement[], files: (files || {}) as Record<string, unknown> };
    dirty.current = true;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = 0;
      void commit();
    }, SAVE_AFTER);
  }

  async function send() {
    if (!onSend) return;
    setBusy("Rendering");
    try {
      const clean = boards.safeScene(scene.current);
      const text = boards.toText(clean, title);
      const png = await boards.toPng(clean, { dark, background: dark ? "#1b1b1f" : "#ffffff" });
      const file = new File([png], `${(title || "whiteboard").replace(/[^\w -]+/g, "").slice(0, 40) || "whiteboard"}.png`, {
        type: "image/png"
      });
      const attachment = await ingest(file, { purpose: "chat" });
      await commit();
      onSend(`Here is my whiteboard.\n\n${text}`, [attachment]);
      onClose();
    } catch (e) {
      setFailed(String((e as Error)?.message || e));
    } finally {
      setBusy(null);
    }
  }

  async function savePng() {
    setBusy("Rendering");
    try {
      const png = await boards.toPng(boards.safeScene(scene.current), { dark, background: dark ? "#1b1b1f" : "#ffffff" });
      const url = URL.createObjectURL(png);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(title || "whiteboard").replace(/[^\w -]+/g, "").slice(0, 40) || "whiteboard"}.png`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        a.remove();
        URL.revokeObjectURL(url);
      }, 5000);
    } catch (e) {
      setFailed(String((e as Error)?.message || e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="sheet">
      <div className="sheet-inner board-sheet" role="dialog" aria-label="Whiteboard">
        <div className="sheet-head">
          <input
            className="board-title"
            value={title}
            aria-label="Board name"
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => {
              dirty.current = true;
              void commit();
            }}
          />
          <span className="sub">{saved ? `saved ${new Date(saved).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "not saved yet"}</span>
          <span className="board-acts">
            {onSend && (
              <button className="btn sm" onClick={() => void send()} disabled={!!busy}>
                {busy || "Send to chat"}
              </button>
            )}
            <button className="btn sm" onClick={() => void savePng()} disabled={!!busy}>
              {onSend ? "PNG" : busy || "PNG"}
            </button>
            {onDelete && (
              <button className="btn sm danger" onClick={onDelete} disabled={!!busy}>
                Delete
              </button>
            )}
          </span>
          <button className="iconbtn" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>

        <div className="board-surface">
          {failed ? (
            <div className="empty">The whiteboard could not open — {failed}</div>
          ) : Board ? (
            <Board.Excalidraw
              initialData={initial}
              theme={dark ? "dark" : "light"}
              name={title}
              onChange={onChange as never}
              validateEmbeddable={false}
              /* A link on a shape opens nothing by itself. http(s) only, in a
                 new tab with no handle back to this one. */
              onLinkOpen={((element: { link?: string }, event: { preventDefault: () => void }) => {
                event.preventDefault();
                const href = String(element?.link || "");
                if (/^https?:\/\//i.test(href)) window.open(href, "_blank", "noopener,noreferrer");
              }) as never}
              UIOptions={{ canvasActions: { loadScene: false, export: false, saveToActiveFile: false, toggleTheme: false } } as never}
            />
          ) : (
            <div className="empty">Opening the whiteboard…</div>
          )}
        </div>
      </div>
    </div>
  );
}
