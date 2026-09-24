/* ============================================================================
 * autoBackup.ts — the backup nobody has to remember to make.
 *
 * START-HERE Phase 11. Everything Drill knows lives in one browser, and the
 * Data page says plainly that four ordinary things wipe it. The answer it gave
 * was "download a backup after any session you would mind losing", which is
 * correct and which nobody does: a backup that depends on remembering is the
 * backup you did not make the week the browser cleared its storage.
 *
 * So, where the browser allows it (Chrome and Edge — the File System Access
 * API), you pick a folder once and Drill writes the same file Settings → Data
 * downloads into it by itself:
 *
 *   drill-auto-2026-09-24.json     one per day, rewritten through the day
 *
 * At most once every ten minutes while something is changing, once shortly
 * after the app opens if the last one is stale, and once more as the tab is
 * hidden. The last `settings.backupKeep` days are kept and older ones pruned —
 * and only files matching that exact name are ever touched, so a folder you
 * also keep other things in is safe from it. Put the folder somewhere a sync
 * client already watches and the backup leaves the machine too.
 *
 * The folder handle survives a reload (it is structured-cloneable, so it lives
 * in IndexedDB), but the permission to write to it often does not: Chrome asks
 * again each session unless you chose "Allow on every visit", and it will only
 * ask from inside a click. That state is `paused`, the Home reminder offers a
 * Resume button, and the button is the click.
 *
 * Where the API does not exist (Firefox, Safari) the status is `unsupported`,
 * and the reminder on Home — driven by storage.lastBackup(), which every
 * download also writes — does the job instead.
 *
 * Not a persistence.guard write, deliberately. A failed automatic backup
 * loses nothing: the data it was copying is still exactly where it was. It
 * reports here, on Home and in Settings, rather than raising the save alarm
 * that means "your work is not being kept".
 * ========================================================================== */
import * as store from "./store";
import * as chatStore from "./chatStore";
import * as journalStore from "./journalStore";
import * as memoryStore from "./memoryStore";
import * as examStore from "./examStore";
import * as candidates from "./candidates";
import * as figures from "./figures";
import { lastBackup, onBackupRecorded, recordBackup } from "./storage";

/* The parts of the File System Access API this uses. Chrome has shipped them
   since 86, but they are not in TypeScript's DOM library, and the async
   iteration over a directory is in a lib this project does not load. */
type Perm = "granted" | "denied" | "prompt";
interface FileHandle {
  kind: "file";
  name: string;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
}
interface DirHandle {
  kind: "directory";
  name: string;
  queryPermission(d: { mode: "readwrite" }): Promise<Perm>;
  requestPermission(d: { mode: "readwrite" }): Promise<Perm>;
  getFileHandle(name: string, o?: { create?: boolean }): Promise<FileHandle>;
  removeEntry(name: string): Promise<void>;
  keys(): AsyncIterableIterator<string>;
}
type PickerWindow = Window & {
  showDirectoryPicker?: (o?: { id?: string; mode?: "readwrite"; startIn?: string }) => Promise<DirHandle>;
};

export type AutoStatus = "unsupported" | "off" | "paused" | "on";

export interface AutoState {
  status: AutoStatus;
  /** The linked folder's own name — all the API will say about where it is. */
  folder: string | null;
  busy: boolean;
  /** The last attempt's failure, in a sentence. Cleared by the next success. */
  error: string | null;
}

const ACTIVE_GAP = 10 * 60 * 1000;
const CHECK_EVERY = 60 * 1000;
const BOOT_DELAY = 15 * 1000;
const HIDE_GAP = 60 * 1000;
export const AUTO_NAME = /^drill-auto-(\d{4})-(\d{2})-(\d{2})\.json$/;

let state: AutoState = { status: "off", folder: null, busy: false, error: null };
let handle: DirHandle | null = null;
let version = 0;
const listeners = new Set<() => void>();

function set(patch: Partial<AutoState>): void {
  state = { ...state, ...patch };
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

export function current(): AutoState {
  return state;
}

/* A download made anywhere is a backup too. Re-broadcast it, so everything
   bound to this store — the Home reminder, the Settings line — redraws. */
onBackupRecorded(() => set({}));

export function supported(): boolean {
  return typeof window !== "undefined" && typeof (window as PickerWindow).showDirectoryPicker === "function";
}

/** The day's file. Local date, because "the backup from Tuesday" means your
 *  Tuesday. */
export function autoName(at = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `drill-auto-${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}.json`;
}

/**
 * Which of the files in the folder to delete: every auto snapshot beyond the
 * newest `keep`. Names sort by date because the date in them is zero-padded
 * and year-first. Anything not matching AUTO_NAME is not ours and is never on
 * this list — including the manual `drill-backup-…` downloads, which someone
 * may well have saved into the same folder. `keep` of 0 means keep all.
 */
export function toPrune(names: string[], keep: number): string[] {
  if (keep <= 0) return [];
  return names
    .filter((n) => AUTO_NAME.test(n))
    .sort()
    .reverse()
    .slice(keep);
}

/* ---------------------------------------------------- the handle's home -- */

/* Its own database, as the audio cache has: a new store in drill-files would
   be a version bump, and a bump blocks while another tab has it open. */
const HANDLE_DB = "drill-backup";
const HANDLE_STORE = "handles";
const HANDLE_KEY = "folder";

function handleDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("no IndexedDB"));
    const req = indexedDB.open(HANDLE_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(HANDLE_STORE)) req.result.createObjectStore(HANDLE_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function readHandle(): Promise<DirHandle | null> {
  const db = await handleDb();
  try {
    return await new Promise<DirHandle | null>((resolve, reject) => {
      const r = db.transaction(HANDLE_STORE, "readonly").objectStore(HANDLE_STORE).get(HANDLE_KEY);
      r.onsuccess = () => resolve((r.result as DirHandle) || null);
      r.onerror = () => reject(r.error);
    });
  } finally {
    db.close();
  }
}

async function writeHandle(h: DirHandle | null): Promise<void> {
  const db = await handleDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(HANDLE_STORE, "readwrite");
      const s = t.objectStore(HANDLE_STORE);
      if (h) s.put(h, HANDLE_KEY);
      else s.delete(HANDLE_KEY);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error("aborted"));
    });
  } finally {
    db.close();
  }
}

/* ------------------------------------------------------------- lifecycle -- */

/** Every store's version, as one string. Changes whenever anything that a
 *  backup would contain has changed in this tab — the same trick
 *  services/activity.ts memoises on. */
function signature(): string {
  return [store, chatStore, journalStore, memoryStore, examStore, candidates, figures].map((m) => m.getVersion()).join(".");
}

let snapSig = "";
let started = false;

export async function init(): Promise<void> {
  if (started) return;
  started = true;
  if (!supported()) {
    set({ status: "unsupported" });
    return;
  }
  try {
    handle = await readHandle();
  } catch {
    handle = null;
  }
  if (!handle) {
    set({ status: "off", folder: null });
  } else {
    const perm = await handle.queryPermission({ mode: "readwrite" }).catch(() => "prompt" as Perm);
    set({ status: perm === "granted" ? "on" : "paused", folder: handle.name });
  }

  /* The first snapshot waits for the app to settle, and only happens at all
     if the last backup of any kind is older than the working gap — opening
     the app five times in an hour is not five backups. */
  setTimeout(() => {
    if (due(ACTIVE_GAP)) void snapshot();
  }, BOOT_DELAY);
  setInterval(() => {
    if (signature() !== snapSig && due(ACTIVE_GAP)) void snapshot();
  }, CHECK_EVERY);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && signature() !== snapSig && due(HIDE_GAP)) void snapshot();
  });
}

function due(gap: number): boolean {
  if (state.status !== "on" || state.busy) return false;
  const last = lastBackup();
  return !last || Date.now() - last.at >= gap;
}

/**
 * Pick the folder. Must be called straight from a click: the picker needs the
 * gesture, which is why nothing is awaited before it opens.
 */
export async function link(): Promise<boolean> {
  const pick = (window as PickerWindow).showDirectoryPicker;
  if (!pick) return false;
  let h: DirHandle;
  try {
    h = await pick({ id: "drill-backups", mode: "readwrite", startIn: "documents" });
  } catch (e) {
    /* Closing the picker is an answer, not an error. */
    if ((e as Error)?.name !== "AbortError") set({ error: describe(e) });
    return false;
  }
  handle = h;
  try {
    await writeHandle(h);
  } catch (e) {
    /* It works for this session either way; it just will not be remembered. */
    set({ error: "The folder works for now, but this browser would not remember it: " + describe(e) });
  }
  set({ status: "on", folder: h.name });
  return snapshot();
}

/** Ask for write access again. Also needs to be called from a click. */
export async function resume(): Promise<boolean> {
  if (!handle) return false;
  try {
    const perm = await handle.requestPermission({ mode: "readwrite" });
    if (perm !== "granted") {
      set({ status: "paused", error: "Permission to write to the folder was not given." });
      return false;
    }
  } catch (e) {
    set({ error: describe(e) });
    return false;
  }
  set({ status: "on", error: null });
  return snapshot();
}

export async function unlink(): Promise<void> {
  handle = null;
  await writeHandle(null).catch(() => undefined);
  set({ status: supported() ? "off" : "unsupported", folder: null, error: null });
}

/** "Back up now" in Settings, and the resume and link paths. */
export function runNow(): Promise<boolean> {
  return snapshot();
}

async function snapshot(): Promise<boolean> {
  const h = handle;
  if (!h || state.busy) return false;
  const perm = await h.queryPermission({ mode: "readwrite" }).catch(() => "prompt" as Perm);
  if (perm !== "granted") {
    if (state.status === "on") set({ status: "paused" });
    return false;
  }

  set({ busy: true });
  const run = async () => {
    /* Read before collecting, so a change that lands while the file is being
       written still counts as unsaved and triggers the next one. */
    const sig = signature();
    const backup = await import("./backup");
    const json = await backup.exportEverything();
    const name = autoName();
    const fh = await h.getFileHandle(name, { create: true });
    /* createWritable writes to a swap file and swaps it in on close(), so a
       tab closed mid-write leaves yesterday's file whole, never half of
       today's. */
    const w = await fh.createWritable();
    await w.write(json);
    await w.close();
    recordBackup({ at: Date.now(), how: "folder", bytes: json.length, file: name });
    snapSig = sig;
    await prune(h);
  };

  try {
    /* Two tabs would write the same file at the same moment. Whichever gets
       the lock writes; the other skips, because the file it would have
       written is the one being written. */
    const locks = (navigator as Navigator & { locks?: LockManager }).locks;
    if (locks) await locks.request("drill-auto-backup", { ifAvailable: true }, async (lock) => (lock ? run() : undefined));
    else await run();
    set({ busy: false, error: null });
    return true;
  } catch (e) {
    const name = (e as Error)?.name;
    if (name === "NotAllowedError" || name === "SecurityError") set({ busy: false, status: "paused", error: null });
    else if (name === "NotFoundError") set({ busy: false, error: "The backup folder has been moved or deleted. Choose it again, or pick another." });
    else set({ busy: false, error: describe(e) });
    return false;
  }
}

async function prune(h: DirHandle): Promise<void> {
  const keep = store.settings().backupKeep;
  if (keep <= 0) return;
  const names: string[] = [];
  for await (const n of h.keys()) names.push(n);
  for (const n of toPrune(names, keep)) {
    /* One stubborn file does not stop the rest, and never fails the backup
       that was just written. */
    await h.removeEntry(n).catch(() => undefined);
  }
}

function describe(e: unknown): string {
  const err = e as { name?: string; message?: string } | null;
  if (err?.name === "QuotaExceededError") return "The disk the folder is on is full.";
  return err?.message || String(e);
}
