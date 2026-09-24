/* ============================================================================
 * storage.ts — the persistence boundary.
 *
 * Everything else in the app talks to `store.ts`, never to localStorage
 * directly. That keeps this the only file that needs to change if Drill ever
 * grows a real backend: swap the read/write pair below for `fetch` calls
 * against your API (e.g. GET/PUT /api/drill-db) and nothing else moves.
 *
 * Also home to the durability helpers, because "how safe is what we stored"
 * is the same question as "where did we store it". Browsers evict origin
 * storage: Safari discards unused site data after about a week, and clearing
 * site data takes everything. Months of memory and review history is the one
 * thing in this app that cannot be regenerated, so the app asks for
 * persistent storage on first run and can report what it was granted.
 *
 * **write() returns a result rather than throwing.** It used to throw, into a
 * `catch` in store.saveNow() that logged to the console and carried on. So the
 * one failure that matters — localStorage full, which is reachable here
 * because a year of review log lives in the same 5MB as the decks — looked
 * exactly like a successful save from every seat in the app. You kept
 * reviewing, nothing was written, and the session was gone on reload. A
 * failure has to be a value the caller must look at.
 * ========================================================================== */

const KEY = "mldrill:v3";
const KEY_OLD = "mldrill:v2";
/** Written once, immediately before the v3 -> v4 upgrade mutates anything. */
const KEY_BACKUP = "mldrill:v3:backup";

export function readCurrent(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function readLegacy(): string | null {
  try {
    return localStorage.getItem(KEY_OLD);
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------------- writing -- */

export type WriteFailure = "quota" | "blocked" | "unknown";

export type WriteResult =
  | { ok: true; bytes: number }
  | { ok: false; reason: WriteFailure; message: string; bytes: number };

/**
 * Which kind of failure this was, because the two need different answers: a
 * quota failure is recoverable by shedding weight and retrying, and a blocked
 * one (private window, third-party storage blocked, storage disabled) never
 * will be, so retrying it just burns the main thread on every keystroke.
 *
 * The name is checked before the code because Safari and Firefox both use
 * legacy numeric codes with their own spellings — 22 in Chrome and Safari,
 * 1014 in Firefox — and a browser that reports neither still has the name.
 */
export function classifyWriteError(e: unknown): WriteFailure {
  const err = e as { name?: string; code?: number } | null;
  const name = err?.name || "";
  if (
    name === "QuotaExceededError" ||
    name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    err?.code === 22 ||
    err?.code === 1014
  ) {
    return "quota";
  }
  if (name === "SecurityError" || name === "InvalidAccessError" || name === "TypeError") return "blocked";
  return "unknown";
}

export function write(json: string): WriteResult {
  const bytes = json.length;
  try {
    localStorage.setItem(KEY, json);
    return { ok: true, bytes };
  } catch (e) {
    return {
      ok: false,
      reason: classifyWriteError(e),
      message: e instanceof Error ? e.message : String(e),
      bytes
    };
  }
}

/** Size of what is actually on disk for the main database, in characters.
 *  Used by the Data page to say how close to the wall you are, and by the
 *  save path to report what it was trying to write when it failed. */
export function storedBytes(): number | null {
  try {
    return localStorage.getItem(KEY)?.length ?? 0;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ last backup -- */

const KEY_LAST_BACKUP = "drill:lastBackup:v1";
const KEY_NUDGE_SNOOZE = "drill:backupSnooze:v1";

export interface BackupRecord {
  at: number;
  /** A file you downloaded, or a snapshot written to the linked folder. */
  how: "download" | "folder";
  bytes: number;
  file: string;
}

/**
 * When everything was last written out, and how.
 *
 * Kept beside the database rather than inside it on purpose: restoring a
 * backup replaces the database whole, and a record that travelled with it
 * would claim the restored file's date as this browser's last backup — which
 * is precisely backwards the one time it matters.
 */
export function lastBackup(): BackupRecord | null {
  try {
    const raw = localStorage.getItem(KEY_LAST_BACKUP);
    if (!raw) return null;
    const r = JSON.parse(raw) as BackupRecord;
    return r && typeof r.at === "number" ? r : null;
  } catch {
    return null;
  }
}

const backupListeners = new Set<() => void>();

/** Told whenever a backup is recorded, from any path — so the Home reminder
 *  and the Settings line change the moment a download finishes rather than
 *  on whatever render happens to come next. */
export function onBackupRecorded(fn: () => void): () => void {
  backupListeners.add(fn);
  return () => backupListeners.delete(fn);
}

export function recordBackup(r: BackupRecord): void {
  try {
    localStorage.setItem(KEY_LAST_BACKUP, JSON.stringify(r));
  } catch {
    /* The drawer is full. The backup itself happened; only the reminder
       will be early, which is the harmless direction to be wrong in. */
  }
  backupListeners.forEach((l) => l());
}

/** "Not now" on the Home reminder, until this time. */
export function backupSnoozedUntil(): number {
  try {
    return Number(localStorage.getItem(KEY_NUDGE_SNOOZE)) || 0;
  } catch {
    return 0;
  }
}

export function snoozeBackupNudge(until: number): void {
  try {
    localStorage.setItem(KEY_NUDGE_SNOOZE, String(until));
  } catch {
    /* it will simply ask again */
  }
}

/* ------------------------------------------------------------------ rescue -- */

/**
 * The stored bytes with every API key blanked, for the rescue page's
 * download. It works on text rather than a parsed object because the reason
 * it exists is a database that does not parse.
 *
 * Every property named `key` in DrillDB is a secret — `settings.key` and each
 * `settings.creds[id].key` — so blanking them all takes nothing else with it.
 * A backup file is the kind of thing that gets mailed to yourself and
 * attached to a bug report, and store.withoutCredentials holds every other
 * export to the same rule.
 */
export function redactKeys(text: string): string {
  return text.replace(/("key"\s*:\s*)"(?:[^"\\]|\\.)*"/g, '$1""');
}

/** Remove the main database, so the next load starts fresh. Only ever called
 *  from the rescue page, after a second press that says what it discards. */
export function discardCurrent(): boolean {
  try {
    localStorage.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------ migration backup -- */

/**
 * Keep a copy of the pre-migration bytes. Deliberately write-once: if the
 * upgrade produced something subtly wrong and the app has been used since,
 * the last thing anyone wants is that broken state overwriting the good
 * snapshot on the next load.
 *
 * Returns true when a backup was written by this call.
 */
export function writeBackupOnce(json: string): boolean {
  try {
    if (localStorage.getItem(KEY_BACKUP) != null) return false;
    localStorage.setItem(KEY_BACKUP, json);
    return true;
  } catch (e) {
    /* Out of quota, or storage is blocked. The caller decides whether to
       proceed; it must not be a silent success. */
    console.error("Could not write pre-migration backup", e);
    return false;
  }
}

export function readBackup(): string | null {
  try {
    return localStorage.getItem(KEY_BACKUP);
  } catch {
    return null;
  }
}

export function hasBackup(): boolean {
  return readBackup() != null;
}

/** Only ever called from an explicit "I have checked my data" action. */
export function clearBackup(): void {
  try {
    localStorage.removeItem(KEY_BACKUP);
  } catch {
    /* nothing to do */
  }
}

/* ------------------------------------------------------------ durability -- */

export interface StorageHealth {
  /** Browser has promised not to evict this origin's data. */
  persisted: boolean;
  /** False when the Storage API is missing entirely (older Safari). */
  supported: boolean;
  /** Bytes in use and available, when the browser will say. */
  usage: number | null;
  quota: number | null;
}

/**
 * Ask the browser to exempt this origin from eviction.
 *
 * Chrome grants it silently for installed or frequently-visited sites,
 * Firefox prompts, Safari decides on its own. A refusal is normal and not an
 * error — the app keeps working, it just also keeps recommending an export.
 *
 * Called twice on purpose: once at boot, where Chrome's heuristics can say
 * yes without bothering anyone, and again from an actual button in
 * Settings → Data. The second one is the one that works in Firefox, because
 * a permission prompt raised without a user gesture is dismissed before
 * anybody sees it — which is why "we already ask at startup" was not enough.
 */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (!navigator.storage || typeof navigator.storage.persist !== "function") return false;
    if (typeof navigator.storage.persisted === "function" && (await navigator.storage.persisted())) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function storageHealth(): Promise<StorageHealth> {
  const out: StorageHealth = { persisted: false, supported: false, usage: null, quota: null };
  try {
    if (!navigator.storage) return out;
    out.supported = typeof navigator.storage.persist === "function";
    if (typeof navigator.storage.persisted === "function") out.persisted = await navigator.storage.persisted();
    if (typeof navigator.storage.estimate === "function") {
      const e = await navigator.storage.estimate();
      out.usage = e.usage ?? null;
      out.quota = e.quota ?? null;
    }
  } catch {
    /* report what we managed to learn */
  }
  return out;
}

export const STORAGE_KEY = KEY;
export const BACKUP_KEY = KEY_BACKUP;
