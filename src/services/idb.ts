/* ============================================================================
 * idb.ts — a small promise wrapper over IndexedDB.
 *
 * Conversations do not belong in localStorage: transcripts run to megabytes,
 * the quota is ~5MB for the whole origin, and every write there is
 * synchronous and rewrites the value whole. This is ~80 lines and removes
 * both problems.
 *
 * Stores:
 *   conversations   full records, keyed by id
 *   meta            one lightweight row per conversation for the sidebar,
 *                   so listing does not deserialise every transcript
 *   memories        what the assistant is told about the learner (v2)
 *   candidates      proposed memories awaiting review in the tray (v2)
 *   journal         daily entries: raw capture + generated narrative (v3)
 *   rollups         weekly period summaries (v3)
 *   exams           generated, gradeable question sets (v3)
 *   usage           one row per day of token spend, by backend/model/feature (v4)
 *
 * Memory (and now journal/exams) live here rather than in the localStorage
 * database for the same reason transcripts do: they grow without a natural
 * bound, and the whole origin only gets ~5MB there.
 * ========================================================================== */

const DB_NAME = "drill-chat";
/** v2 added memories and candidates. v3 added journal, rollups and exams.
 *  v4 adds the usage ledger. */
const DB_VERSION = 4;
export const STORE_CONV = "conversations";
export const STORE_META = "meta";
export const STORE_MEM = "memories";
export const STORE_CAND = "candidates";
export const STORE_JOURNAL = "journal";
export const STORE_ROLLUPS = "rollups";
export const STORE_EXAMS = "exams";
export const STORE_USAGE = "usage";

let dbPromise: Promise<IDBDatabase> | null = null;

/**
 * One connection for the life of the page — until something takes it away.
 *
 * Three things can, and each used to strand every read and write until a
 * reload, because the promise was cached whatever became of it:
 *
 *  - **The open failing once.** A rejected promise stayed cached, so a
 *    transient refusal (another tab mid-upgrade, a busy disk) became a
 *    permanent one. The next caller now tries again.
 *  - **A newer version in another tab.** That tab's open waits on this one's
 *    connection and fires `blocked` there until it is closed. With no
 *    `versionchange` handler here, a tab left open after a deploy that bumps
 *    this database froze the new one on its first read. drill-files already
 *    let go when asked; this one did not.
 *  - **The browser closing the connection** — site data cleared, the disk
 *    gone, storage evicted mid-session. `close` fires and the handle is dead;
 *    the next transaction on it throws InvalidStateError.
 *
 * In each case the cache is cleared, so the next call opens afresh, and tx()
 * below retries once on a dead handle rather than reporting a lost write that
 * a second attempt would have landed.
 */
function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const p = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("this browser has no IndexedDB"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    /* Guarded by contains() rather than switching on oldVersion, so the same
       block upgrades a v1 database and creates a fresh one. */
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_CONV)) db.createObjectStore(STORE_CONV, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORE_META)) {
        const s = db.createObjectStore(STORE_META, { keyPath: "id" });
        s.createIndex("updated", "updated");
      }
      if (!db.objectStoreNames.contains(STORE_MEM)) {
        const s = db.createObjectStore(STORE_MEM, { keyPath: "id" });
        /* Retrieval always narrows to one scope + project before scoring. */
        s.createIndex("scope_project", ["scope", "projectId"]);
        s.createIndex("updatedAt", "updatedAt");
      }
      if (!db.objectStoreNames.contains(STORE_CAND)) {
        const s = db.createObjectStore(STORE_CAND, { keyPath: "id" });
        s.createIndex("status", "status");
      }
      if (!db.objectStoreNames.contains(STORE_JOURNAL)) {
        const s = db.createObjectStore(STORE_JOURNAL, { keyPath: "id" });
        s.createIndex("projectId", "projectId");
        /* One entry per project per day — the compound index is how
           getOrCreateToday finds it without scanning every entry. */
        s.createIndex("project_day", ["projectId", "day"], { unique: true });
      }
      if (!db.objectStoreNames.contains(STORE_ROLLUPS)) {
        const s = db.createObjectStore(STORE_ROLLUPS, { keyPath: "id" });
        s.createIndex("projectId", "projectId");
      }
      if (!db.objectStoreNames.contains(STORE_EXAMS)) {
        const s = db.createObjectStore(STORE_EXAMS, { keyPath: "id" });
        s.createIndex("projectId", "projectId");
      }
      if (!db.objectStoreNames.contains(STORE_USAGE)) {
        /* Keyed by day, so a day's spend accumulates into one record rather
           than one row per call. `at` is the day's start in epoch ms, which
           is what range queries filter on — day strings are for display. */
        const s = db.createObjectStore(STORE_USAGE, { keyPath: "day" });
        s.createIndex("at", "at");
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      const forget = () => {
        if (dbPromise === p) dbPromise = null;
      };
      /* A later version opened in another tab asks this one to let go. */
      db.onversionchange = () => {
        db.close();
        forget();
      };
      db.onclose = forget;
      resolve(db);
    };
    req.onerror = () => reject(req.error || new Error("IndexedDB refused to open"));
    req.onblocked = () => reject(new Error("IndexedDB is blocked by another open tab"));
  });
  dbPromise = p;
  p.catch(() => {
    if (dbPromise === p) dbPromise = null;
  });
  return p;
}

/** The handle was closed under us — by versionchange, by the browser, by
 *  site data being cleared. Worth one fresh connection; anything else is a
 *  real failure and is passed up to be reported. */
function isDeadHandle(e: unknown): boolean {
  return (e as { name?: string } | null)?.name === "InvalidStateError";
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>, retried = false): Promise<T> {
  return openDB()
    .then(
      (db) =>
        new Promise<T>((resolve, reject) => {
          /* transaction() throws synchronously on a closed handle; inside the
             executor that becomes a rejection, which the catch below reads. */
          const t = db.transaction(store, mode);
          const req = fn(t.objectStore(store));
          /* A write is settled by the transaction, not the request. The
             request succeeds when the value is queued; running out of room is
             discovered at commit, and arrives as an abort *after* that — so
             resolving on the request reported a write that never landed as
             saved, and persistence.guard, which exists for exactly that
             failure, never heard about it. Reads have nothing to commit and
             still answer as soon as they can. */
          let value: T;
          req.onsuccess = () => {
            value = req.result;
            if (mode === "readonly") resolve(value);
          };
          req.onerror = () => reject(req.error);
          t.oncomplete = () => resolve(value);
          t.onabort = () => reject(t.error || new Error("transaction aborted"));
        })
    )
    .catch((e) => {
      if (retried || !isDeadHandle(e)) throw e;
      dbPromise = null;
      return tx(store, mode, fn, true);
    });
}

export function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  return tx<T | undefined>(store, "readonly", (s) => s.get(key) as IDBRequest<T | undefined>);
}

export function idbPut<T>(store: string, value: T): Promise<void> {
  return tx(store, "readwrite", (s) => s.put(value) as IDBRequest<IDBValidKey>).then(() => undefined);
}

export function idbDelete(store: string, key: string): Promise<void> {
  return tx(store, "readwrite", (s) => s.delete(key) as unknown as IDBRequest<undefined>).then(() => undefined);
}

export function idbAll<T>(store: string): Promise<T[]> {
  return tx<T[]>(store, "readonly", (s) => s.getAll() as IDBRequest<T[]>);
}

export function idbClear(store: string): Promise<void> {
  return tx(store, "readwrite", (s) => s.clear() as unknown as IDBRequest<undefined>).then(() => undefined);
}

/**
 * Write many records in one transaction. Restoring a backup one idbPut at a
 * time means one transaction per record; for a few thousand memories that is
 * the difference between instant and visibly slow.
 */
export function idbBulkPut<T>(store: string, values: T[], retried = false): Promise<void> {
  if (!values.length) return Promise.resolve();
  return openDB()
    .then(
      (db) =>
        new Promise<void>((resolve, reject) => {
          const t = db.transaction(store, "readwrite");
          const s = t.objectStore(store);
          for (const v of values) s.put(v);
          t.oncomplete = () => resolve();
          t.onerror = () => reject(t.error);
          t.onabort = () => reject(t.error || new Error("transaction aborted"));
        })
    )
    .catch((e) => {
      if (retried || !isDeadHandle(e)) throw e;
      dbPromise = null;
      return idbBulkPut(store, values, true);
    });
}

/** True when IndexedDB is usable at all. Private windows and some locked-down
 *  browser profiles refuse it; the chat view says so rather than silently
 *  losing what you type. */
export async function idbAvailable(): Promise<boolean> {
  try {
    if (typeof indexedDB === "undefined") return false;
    await openDB();
    return true;
  } catch {
    return false;
  }
}
