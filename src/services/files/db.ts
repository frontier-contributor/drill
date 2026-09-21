/* ============================================================================
 * db.ts — the bytes of attached files, in a database of their own.
 *
 * `drill-files`, not a store inside `drill-chat`, for the reason the audio
 * cache lives apart too: a new store in drill-chat is a version bump, and a
 * bump blocks for as long as another tab holds the old version open. Unlike the
 * audio cache this is not disposable. A photo of a derivation you attached is
 * something you made, so every write goes through persistence.guard and a
 * failed one raises the same alarm a lost conversation would.
 *
 * The conversation keeps an attachment's text, thumbnail and id; this keeps the
 * original. Nothing counts references — services/files/sweep.ts reads every
 * conversation to decide what is still in use.
 *
 * Whiteboards live here too, in a second store, and kept figures in a third.
 * A board is the same kind of thing by every measure that decided where files
 * go: it is work you made, it is far too big for localStorage, and it is
 * rewritten far too often to sit inside the conversation record, which is
 * serialised whole on every message. A kept figure answers the same way — a
 * canvas is a few hundred lines of HTML, and the point of keeping one is that
 * it outlives the thread that wrote it. One database means one version line to
 * reason about rather than three.
 * ========================================================================== */
import type { KeptFigure } from "@/lib/visuals/keep";
import * as persistence from "@/services/persistence";

const DB_NAME = "drill-files";
/* 2 added the boards store, 3 the kept figures. A bump blocks while another
   tab holds the old version open, which is why this database is small and
   rarely changed. */
const DB_VERSION = 3;
const BLOBS = "blobs";
const BOARDS = "boards";
const FIGURES = "figures";

export interface StoredFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  created: number;
  blob: Blob;
}

export type StoredFileMeta = Omit<StoredFile, "blob">;

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const p = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("this browser has no IndexedDB"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(BOARDS)) db.createObjectStore(BOARDS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(FIGURES)) db.createObjectStore(FIGURES, { keyPath: "id" });
    };
    req.onsuccess = () => {
      const db = req.result;
      /* A later version opened in another tab asks this one to let go. */
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error || new Error("the file store could not be opened"));
    req.onblocked = () => reject(new Error("the file store is held open by another tab"));
  });
  dbPromise = p;
  p.catch(() => {
    if (dbPromise === p) dbPromise = null;
  });
  return p;
}

function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("transaction aborted"));
  });
}

function result<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** True when it landed. False has already raised the save alarm. */
export async function put(file: StoredFile): Promise<boolean> {
  const ok = await persistence.guard(
    "attached file",
    (async () => {
      const db = await open();
      const tx = db.transaction(BLOBS, "readwrite");
      tx.objectStore(BLOBS).put(file);
      await committed(tx);
      return true as const;
    })()
  );
  return ok === true;
}

/** Undefined when it is not here — a restored backup made without files, or a
 *  browser that cleared its storage. A missing file is not a failed save. */
export async function get(id: string): Promise<StoredFile | undefined> {
  try {
    const db = await open();
    return await result<StoredFile | undefined>(db.transaction(BLOBS, "readonly").objectStore(BLOBS).get(id));
  } catch {
    return undefined;
  }
}

export async function remove(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await persistence.guard(
    "attached file",
    (async () => {
      const db = await open();
      const tx = db.transaction(BLOBS, "readwrite");
      const store = tx.objectStore(BLOBS);
      for (const id of ids) store.delete(id);
      await committed(tx);
    })()
  );
}

/** Everything held. A Blob read back out of IndexedDB is a handle to the bytes,
 *  not the bytes, so listing a gigabyte of photos does not load a gigabyte. */
export async function list(): Promise<StoredFileMeta[]> {
  try {
    const db = await open();
    const all = await result<StoredFile[]>(db.transaction(BLOBS, "readonly").objectStore(BLOBS).getAll());
    return all.map(({ blob: _bytes, ...meta }) => meta);
  } catch {
    return [];
  }
}

/**
 * Add files without clearing what is here.
 *
 * For a backup that carries *some* files rather than all of them — one made
 * without attachments still brings the pictures a kept figure points at, since
 * those are nothing but their bytes. Clearing the store for those would delete
 * every attachment in the browser being restored into.
 */
export async function putAll(files: StoredFile[]): Promise<void> {
  if (!files.length) return;
  await persistence.guard(
    "attached file",
    (async () => {
      const db = await open();
      const tx = db.transaction(BLOBS, "readwrite");
      const store = tx.objectStore(BLOBS);
      for (const f of files) store.put(f);
      await committed(tx);
    })()
  );
}

/** For restoring a backup that carries every file: this browser's files become
 *  exactly the backup's. */
export async function replaceAll(files: StoredFile[]): Promise<void> {
  await persistence.guard(
    "attached file",
    (async () => {
      const db = await open();
      const tx = db.transaction(BLOBS, "readwrite");
      const store = tx.objectStore(BLOBS);
      store.clear();
      for (const f of files) store.put(f);
      await committed(tx);
    })()
  );
}

/* ------------------------------------------------------------------ boards -- */

/** A whiteboard: Excalidraw's own scene, plus what it takes to show it in a
 *  list. `elements` and `files` are whatever the library handed over — this
 *  module does not interpret either, it keeps them. */
export interface StoredBoard {
  id: string;
  title: string;
  projectId: string;
  /** The conversation it was opened from, when it was opened from one. */
  conversationId?: string;
  created: number;
  updated: number;
  elements: unknown[];
  /** Images pasted into the board, in Excalidraw's own BinaryFiles shape. */
  files?: Record<string, unknown>;
  /** Only the parts of the app state worth keeping: a scroll position and a
   *  background, never the whole thing, which carries pointers and cursors. */
  view?: Record<string, unknown>;
}

export async function putBoard(board: StoredBoard): Promise<boolean> {
  const ok = await persistence.guard(
    "whiteboard",
    (async () => {
      const db = await open();
      const tx = db.transaction(BOARDS, "readwrite");
      tx.objectStore(BOARDS).put(board);
      await committed(tx);
      return true as const;
    })()
  );
  return ok === true;
}

export async function getBoard(id: string): Promise<StoredBoard | undefined> {
  try {
    const db = await open();
    return await result<StoredBoard | undefined>(db.transaction(BOARDS, "readonly").objectStore(BOARDS).get(id));
  } catch {
    return undefined;
  }
}

export async function listBoards(): Promise<StoredBoard[]> {
  try {
    const db = await open();
    const all = await result<StoredBoard[]>(db.transaction(BOARDS, "readonly").objectStore(BOARDS).getAll());
    return all.sort((a, b) => b.updated - a.updated);
  } catch {
    return [];
  }
}

export async function removeBoards(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await persistence.guard(
    "whiteboard",
    (async () => {
      const db = await open();
      const tx = db.transaction(BOARDS, "readwrite");
      const store = tx.objectStore(BOARDS);
      for (const id of ids) store.delete(id);
      await committed(tx);
    })()
  );
}

/** For restoring a backup that carries boards. */
export async function replaceAllBoards(boards: StoredBoard[]): Promise<void> {
  await persistence.guard(
    "whiteboard",
    (async () => {
      const db = await open();
      const tx = db.transaction(BOARDS, "readwrite");
      const store = tx.objectStore(BOARDS);
      store.clear();
      for (const b of boards) store.put(b);
      await committed(tx);
    })()
  );
}

/* ----------------------------------------------------------------- figures -- */
/* A figure lifted out of the reply that drew it. What it holds is the fenced
   block itself (lib/visuals/keep.ts), so a kept figure is drawn by exactly the
   same renderer as the one in the conversation — there is no second format to
   keep in step with the first. */

export async function putFigure(figure: KeptFigure): Promise<boolean> {
  const ok = await persistence.guard(
    "kept figure",
    (async () => {
      const db = await open();
      const tx = db.transaction(FIGURES, "readwrite");
      tx.objectStore(FIGURES).put(figure);
      await committed(tx);
      return true as const;
    })()
  );
  return ok === true;
}

export async function listFigures(): Promise<KeptFigure[]> {
  try {
    const db = await open();
    const all = await result<KeptFigure[]>(db.transaction(FIGURES, "readonly").objectStore(FIGURES).getAll());
    return all.sort((a, b) => b.updated - a.updated);
  } catch {
    return [];
  }
}

export async function removeFigures(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await persistence.guard(
    "kept figure",
    (async () => {
      const db = await open();
      const tx = db.transaction(FIGURES, "readwrite");
      const store = tx.objectStore(FIGURES);
      for (const id of ids) store.delete(id);
      await committed(tx);
    })()
  );
}

/** For restoring a backup that carries kept figures. */
export async function replaceAllFigures(figures: KeptFigure[]): Promise<void> {
  await persistence.guard(
    "kept figure",
    (async () => {
      const db = await open();
      const tx = db.transaction(FIGURES, "readwrite");
      const store = tx.objectStore(FIGURES);
      store.clear();
      for (const f of figures) store.put(f);
      await committed(tx);
    })()
  );
}
