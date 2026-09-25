/* ============================================================================
 * catalogueCache.ts — where the model catalogue waits between visits.
 *
 * It lived in localStorage, which was fine at 460 text models trimmed to a
 * price each. With every modality and a description per model it is several
 * hundred kilobytes, and localStorage is the ~5MB drawer the review log has to
 * fit in — store.saveNow() sheds a learner's history when that drawer fills,
 * and a cache of other people's model cards is the last thing that should
 * cost them any of it.
 *
 * So it has its own IndexedDB database, `drill-catalogue`, for the reason the
 * audio cache has its own: a new store inside drill-chat would be a version
 * bump, and a bump blocks while another tab holds the old version open. Like
 * that cache, and unlike everything under persistence.guard, a failed write
 * here loses nothing anyone made — the next visit fetches it again — so
 * failures are swallowed on purpose rather than raising the save alarm.
 *
 * Key–value: "models", "images", "videos", each `{at, data}`.
 * ========================================================================== */

const DB_NAME = "drill-catalogue";
const STORE = "entries";

export interface Cached<T> {
  at: number;
  data: T;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const p = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("no IndexedDB"));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      db.onclose = () => {
        if (dbPromise === p) dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("blocked"));
  });
  dbPromise = p;
  p.catch(() => {
    if (dbPromise === p) dbPromise = null;
  });
  return p;
}

export async function readCached<T>(key: string): Promise<Cached<T> | null> {
  try {
    const db = await open();
    return await new Promise<Cached<T> | null>((resolve) => {
      const r = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
      r.onsuccess = () => resolve((r.result as Cached<T>) || null);
      r.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function writeCached<T>(key: string, data: T): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((resolve) => {
      const t = db.transaction(STORE, "readwrite");
      t.objectStore(STORE).put({ at: Date.now(), data } satisfies Cached<T>, key);
      t.oncomplete = () => resolve();
      t.onerror = () => resolve();
      t.onabort = () => resolve();
    });
  } catch {
    /* a cache that will not write is a cache miss tomorrow, nothing more */
  }
}

export async function clearCached(): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((resolve) => {
      const t = db.transaction(STORE, "readwrite");
      t.objectStore(STORE).clear();
      t.oncomplete = () => resolve();
      t.onerror = () => resolve();
    });
  } catch {
    /* nothing to clear */
  }
}
