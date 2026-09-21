/* ============================================================================
 * figures.ts — the shelf: figures you kept, and the whiteboards you drew.
 *
 * Same singleton + subscribe shape as examStore/journalStore, over the
 * `figures` and `boards` stores of `drill-files` rather than `drill-chat`.
 * One module for both because they are one page: from where you are standing,
 * a diagram you kept and a board you drew are the same kind of thing — work
 * you made and want to find again — and a section with two subscriptions that
 * can disagree about whether it has loaded yet is a section that flickers.
 *
 * Boards, note, have been saved since the whiteboard shipped and were listed
 * by nothing: `listBoards` had exactly one caller, the backup. A board you
 * drew survived the reload and there was no way to open it. That is fixed by
 * this module existing, not by anything clever in it.
 *
 * Writing is `keep()`, and what it does when the same figure arrives twice is
 * lib/visuals/keep.ts's decision, not this file's — it is the part with a
 * failure mode, so it is the part that is pure and tested.
 * ========================================================================== */
import * as U from "@/lib/util";
import { foldKeep, figureKey, type KeepInput, type KeepStatus, type KeptBlock, type KeptFigure } from "@/lib/visuals/keep";
import type { VisualBlock } from "@/lib/visuals/catalogue";
import * as db from "./files/db";
import type { StoredBoard } from "./files/db";

let figures: KeptFigure[] = [];
let boardList: StoredBoard[] = [];
let loaded = false;
let version = 0;
const listeners = new Set<() => void>();

function notify(): void {
  version++;
  listeners.forEach((l) => l());
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getVersion(): number {
  return version;
}

export function isLoaded(): boolean {
  return loaded;
}

export async function init(): Promise<void> {
  if (loaded) return;
  return reload();
}

export async function reload(): Promise<void> {
  const [f, b] = await Promise.all([db.listFigures(), db.listBoards()]);
  figures = f;
  boardList = b;
  loaded = true;
  notify();
}

/** Boards alone — after a board sheet has closed, since it saves itself on a
 *  timer and this list is a snapshot of when it was read. */
export async function reloadBoards(): Promise<void> {
  boardList = await db.listBoards();
  notify();
}

/* ------------------------------------------------------------------ read -- */

/** Newest first, by when each was last revised rather than first kept: a
 *  canvas you came back to three times is a thing you are working on. */
export function list(projectId: string): KeptFigure[] {
  return figures.filter((f) => f.projectId === projectId).sort((a, b) => b.updated - a.updated);
}

export function get(id: string): KeptFigure | undefined {
  return figures.find((f) => f.id === id);
}

export function boards(projectId: string): StoredBoard[] {
  return boardList.filter((b) => b.projectId === projectId);
}

export function board(id: string): StoredBoard | undefined {
  return boardList.find((b) => b.id === id);
}

/** Whether this exact block is already on the shelf — what the Keep button
 *  reads, on every figure in a reply, on every render. A lookup over one
 *  project's figures, so it stays a lookup. */
export function keptFor(
  block: Pick<KeptBlock, "kind" | "source" | "info">,
  where: { projectId: string; conversationId?: string }
): KeptFigure | undefined {
  /* A canvas's key covers every version of it, so stepping back to v1 of one
     you kept at v3 still reads as kept — which is right: it is on the shelf,
     under the arrow. Every other kind is keyed by its own source, so a match
     is the same block. */
  const key = figureKey(block, where);
  return figures.find((f) => f.key === key);
}

/* ----------------------------------------------------------------- write -- */

function persist(f: KeptFigure): void {
  void db.putFigure(f);
  notify();
}

/**
 * Put a figure on the shelf.
 *
 * Returns what actually happened so the button can say it: keeping the same
 * block twice is `already` and writes nothing, and a canvas rewritten under
 * the same title in the same thread is `revised` — the source it replaces goes
 * into the record's versions rather than over the side.
 */
export function keep(input: KeepInput): { figure: KeptFigure; status: KeepStatus } {
  const existing = keptFor(input.block, input);
  const folded = foldKeep(existing, input, Date.now(), U.uuid);
  if (folded.status === "already") return folded;

  figures = [folded.figure, ...figures.filter((f) => f.id !== folded.figure.id)];
  persist(folded.figure);
  return folded;
}

/** Your title, not the model's. `key` is deliberately left alone: renaming a
 *  figure must not turn the next revision of it into a second figure. */
export function rename(id: string, title: string): void {
  const f = get(id);
  if (!f) return;
  f.title = title.trim() || f.title;
  persist(f);
}

/** Why you kept it. Saved on blur like every other field in the app. */
export function setNote(id: string, note: string): void {
  const f = get(id);
  if (!f || f.note === note) return;
  f.note = note;
  persist(f);
}

export function remove(id: string): void {
  figures = figures.filter((f) => f.id !== id);
  void db.removeFigures([id]);
  notify();
}

export function removeBoard(id: string): void {
  boardList = boardList.filter((b) => b.id !== id);
  void db.removeBoards([id]);
  notify();
}

/** After a board sheet has saved: the list holds a copy, and a stale title in
 *  it is the one thing you would notice immediately. */
export function noteBoard(b: StoredBoard): void {
  boardList = [b, ...boardList.filter((x) => x.id !== b.id)];
  notify();
}
