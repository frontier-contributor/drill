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
 * ========================================================================== */
import * as persistence from "@/services/persistence";

const DB_NAME = "drill-files";
const DB_VERSION = 1;
const BLOBS = "blobs";

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

/** For restoring a backup that carries files: this browser's files become
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
