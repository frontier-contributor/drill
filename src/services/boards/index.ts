/* ============================================================================
 * boards — whiteboards: where they come from, and what leaves them.
 *
 * A board is an Excalidraw scene kept in the `boards` store of `drill-files`
 * (see services/files/db.ts for why it is there and not in the conversation).
 * This module is everything about a board that is not the drawing surface
 * itself: making one from a diagram the model drew, from element skeletons it
 * wrote, or empty; saving it; and turning it into the two things chat sends —
 * a picture, and a sentence-by-sentence reading for a model that cannot see.
 *
 * Safety, in one place because it is easy to lose:
 *
 *   Every element that arrives from anywhere but the person drawing has its
 *   `link` removed. Excalidraw renders a link as a button that opens it, so a
 *   board written by a model is otherwise a way to put a clickable URL in
 *   front of you that you did not type.
 *
 *   An image element survives only if its bytes are a data: URL. Anything
 *   pointing outward is dropped rather than fetched.
 * ========================================================================== */
import { uuid } from "@/lib/util";
import { boardToText, type BoardElement } from "@/lib/visuals/boardText";
import * as db from "@/services/files/db";
import { excalidraw } from "./library";

export type { StoredBoard } from "@/services/files/db";

export interface BoardScene {
  elements: BoardElement[];
  files?: Record<string, unknown>;
}

/** Everything a board carries in from outside goes through this. */
export function safeScene(scene: BoardScene): BoardScene {
  const files = scene.files || {};
  const kept: Record<string, unknown> = {};
  for (const [id, file] of Object.entries(files)) {
    const url = (file as { dataURL?: unknown })?.dataURL;
    if (typeof url === "string" && url.startsWith("data:")) kept[id] = file;
  }

  const elements = (scene.elements || [])
    .filter((el) => {
      if (el?.type !== "image") return true;
      const fileId = (el as { fileId?: unknown }).fileId;
      return typeof fileId === "string" && fileId in kept;
    })
    .map((el) => {
      if (!el || !("link" in el) || el.link == null) return el;
      const { link: _dropped, ...rest } = el as BoardElement & { link?: unknown };
      return rest as BoardElement;
    });

  return { elements, files: kept };
}

export function newBoard(opts: {
  projectId: string;
  conversationId?: string;
  title: string;
  scene?: BoardScene;
}): db.StoredBoard {
  const scene = safeScene(opts.scene || { elements: [] });
  const now = Date.now();
  return {
    id: uuid(),
    title: opts.title || "Whiteboard",
    projectId: opts.projectId,
    conversationId: opts.conversationId,
    created: now,
    updated: now,
    elements: scene.elements,
    files: scene.files
  };
}

export const save = db.putBoard;
export const load = db.getBoard;
export const list = db.listBoards;
export const remove = db.removeBoards;

/** A Mermaid diagram as editable shapes. Whatever the converter cannot lay out
 *  it hands back as an image element, which is why this never throws for a
 *  diagram type it has not met. */
export async function fromMermaid(source: string): Promise<BoardScene> {
  const [{ parseMermaidToExcalidraw }, lib] = await Promise.all([
    import("@excalidraw/mermaid-to-excalidraw"),
    excalidraw()
  ]);
  const { elements, files } = await parseMermaidToExcalidraw(source, { themeVariables: { fontSize: "16px" } });
  return safeScene({
    elements: lib.convertToExcalidrawElements(elements) as unknown as BoardElement[],
    files: files as Record<string, unknown> | undefined
  });
}

/** A board the model wrote, as element skeletons — the small JSON shape
 *  Excalidraw documents, not its internal element format. */
export async function fromSkeletons(json: string): Promise<BoardScene> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(`the board is not valid JSON (${(e as Error).message})`);
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { elements?: unknown })?.elements;
  if (!Array.isArray(list)) throw new Error("the board should be a JSON array of elements");
  const lib = await excalidraw();
  const elements = lib.convertToExcalidrawElements(list as never) as unknown as BoardElement[];
  return safeScene({ elements });
}

/** The board as a picture. Transparent backgrounds read as a black rectangle
 *  on a night page in half the places a PNG ends up, so it gets the page it
 *  was drawn on. */
export async function toPng(scene: BoardScene, opts: { dark: boolean; background: string }): Promise<Blob> {
  const lib = await excalidraw();
  return await lib.exportToBlob({
    elements: scene.elements as never,
    files: (scene.files || {}) as never,
    mimeType: "image/png",
    quality: 0.92,
    exportPadding: 16,
    appState: { exportBackground: true, viewBackgroundColor: opts.background, theme: opts.dark ? "dark" : "light" } as never
  });
}

export function toText(scene: BoardScene, title?: string): string {
  return boardToText(scene.elements, title);
}
