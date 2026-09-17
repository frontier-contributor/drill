/* ============================================================================
 * backup.ts — everything Drill knows, in one file.
 *
 * Drill keeps its data in two places for good reasons (see store.ts and
 * idb.ts), which means neither one alone is a backup. This module is the only
 * thing that sees both: the localStorage database *and* every IndexedDB
 * store, written out together and restored together.
 *
 * Why this matters more than it looks: browsers evict origin storage. Safari
 * discards unused site data after about a week, and "clear site data" takes
 * everything with it. Cards can be re-imported from a deck file; months of
 * review history and accumulated memory cannot be regenerated from anything.
 * This file is the reason losing them is recoverable.
 *
 * Restore preserves ids on purpose. Conversations, notes and memories all
 * reference projects by id, so re-keying on import — which is right for
 * *merging* one deck or one conversation into an existing database — would
 * quietly sever every one of those links.
 * ========================================================================== */
import * as store from "./store";
import * as chatStore from "./chatStore";
import * as journalStore from "./journalStore";
import * as usageLog from "./usageLog";
import * as memoryStore from "./memoryStore";
import * as candidates from "./candidates";
import * as examStore from "./examStore";
import * as U from "@/lib/util";
import { idbAll, idbBulkPut, idbClear, STORE_CAND, STORE_CONV, STORE_EXAMS, STORE_JOURNAL, STORE_MEM, STORE_ROLLUPS, STORE_USAGE } from "./idb";
import { CURRENT_DB_VERSION, dbVersionOf } from "@/lib/migrate";
import type { BackupSummary, DrillDB, FullBackup, LegacyDBv2, LegacyDBv3, Memory, MemoryCandidate } from "@/types";
import type { Conversation } from "@/types/chat";
import type { JournalEntry, PeriodRollup } from "@/types/journal";
import type { Exam } from "@/types/exam";
import type { UsageDay } from "./usageLog";
import * as filesDb from "./files/db";
import { base64ToBlob, blobToBase64 } from "./files/bytes";

const KIND = "drill-full-backup";

/* ----------------------------------------------------------------- export -- */

export interface CollectOptions {
  /** Attached pictures and PDFs, as base64. Off unless asked for: they can be
   *  most of the file's size, and a backup too big to make is one nobody makes. */
  includeFiles?: boolean;
}

export async function collect(opts: CollectOptions = {}): Promise<FullBackup> {
  /* Flush anything still sitting in the debounce queue, or the newest turn of
     the conversation you are looking at would be missing from its own backup. */
  chatStore.flushAll();
  store.saveNow();

  usageLog.flushAll();

  /* Saved audio from reading replies aloud is deliberately not collected. It
     lives in a database of its own (services/speech/cache.ts), can be fetched
     again from the voice that made it, and would make a backup megabytes
     larger for nothing anyone wrote. */
  const [conversations, memories, memCandidates, journal, rollups, exams, usage] = await Promise.all([
    idbAll<Conversation>(STORE_CONV).catch(() => [] as Conversation[]),
    idbAll<Memory>(STORE_MEM).catch(() => [] as Memory[]),
    idbAll<MemoryCandidate>(STORE_CAND).catch(() => [] as MemoryCandidate[]),
    idbAll<JournalEntry>(STORE_JOURNAL).catch(() => [] as JournalEntry[]),
    idbAll<PeriodRollup>(STORE_ROLLUPS).catch(() => [] as PeriodRollup[]),
    idbAll<Exam>(STORE_EXAMS).catch(() => [] as Exam[]),
    idbAll<UsageDay>(STORE_USAGE).catch(() => [] as UsageDay[])
  ]);

  return {
    kind: KIND,
    version: 1,
    exportedAt: Date.now(),
    dbVersion: CURRENT_DB_VERSION,
    db: store.withoutCredentials(store.get()),
    conversations,
    memories,
    candidates: memCandidates,
    journal,
    rollups,
    exams,
    usage,
    boards: await filesDb.listBoards(),
    ...(opts.includeFiles ? { files: await collectFiles() } : {})
  };
}

/** One file at a time, so a backup of a thousand photos holds one photo's
 *  base64 in memory at once rather than all of them. */
async function collectFiles(): Promise<NonNullable<FullBackup["files"]>> {
  const out: NonNullable<FullBackup["files"]> = [];
  for (const meta of await filesDb.list()) {
    const rec = await filesDb.get(meta.id);
    if (!rec) continue;
    out.push({ id: rec.id, name: rec.name, mime: rec.mime, size: rec.size, created: rec.created, data: await blobToBase64(rec.blob) });
  }
  return out;
}

export async function exportEverything(opts: CollectOptions = {}): Promise<string> {
  return JSON.stringify(await collect(opts), null, 1);
}

/** Filename carries the date so a folder of these sorts sensibly. */
export function backupFilename(at = Date.now()): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `drill-backup-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.json`;
}

export async function downloadEverything(opts: CollectOptions = {}): Promise<void> {
  const json = await exportEverything(opts);
  U.download(backupFilename(), json, "application/json");
}

/* ----------------------------------------------------------------- import -- */

/** Thrown for a file that is not a Drill backup at all, so the UI can say so
 *  rather than showing a JSON parser's complaint. */
export class BackupFormatError extends Error {}

export function parse(text: string): FullBackup {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch (e) {
    throw new BackupFormatError("That file is not valid JSON (" + (e as Error).message + ")");
  }
  if (!j || typeof j !== "object") throw new BackupFormatError("That file does not contain a backup.");
  const b = j as Partial<FullBackup>;
  if (b.kind !== KIND) {
    throw new BackupFormatError(
      "That is not a full Drill backup. A deck file or a conversations export can be brought in from the Import pane instead."
    );
  }
  if (!b.db || typeof b.db !== "object") throw new BackupFormatError("The backup has no database in it.");
  return {
    kind: KIND,
    version: 1,
    exportedAt: b.exportedAt || 0,
    dbVersion: dbVersionOf(b.db),
    db: b.db,
    conversations: Array.isArray(b.conversations) ? b.conversations : [],
    memories: Array.isArray(b.memories) ? b.memories : [],
    candidates: Array.isArray(b.candidates) ? b.candidates : [],
    journal: Array.isArray(b.journal) ? b.journal : [],
    rollups: Array.isArray(b.rollups) ? b.rollups : [],
    exams: Array.isArray(b.exams) ? b.exams : [],
    usage: Array.isArray(b.usage) ? b.usage : [],
    files: Array.isArray(b.files) ? b.files : undefined,
    boards: Array.isArray(b.boards) ? b.boards : []
  };
}

/** What restoring this file would bring in. Shown for confirmation *before*
 *  anything is replaced, because restore is not additive. */
export function summarise(b: FullBackup): BackupSummary {
  const db = b.db as Partial<DrillDB>;
  const decks = db.decks || {};
  let cards = 0;
  for (const id of Object.keys(decks)) cards += (decks[id].cards || []).length;
  return {
    exportedAt: b.exportedAt,
    dbVersion: b.dbVersion,
    projects: Object.keys(db.projects || {}).length,
    decks: Object.keys(decks).length,
    cards,
    notes: (db.notes || []).length,
    conversations: b.conversations.length,
    memories: b.memories.length,
    candidates: b.candidates.length,
    journal: b.journal.length,
    exams: b.exams.length,
    files: b.files?.length || 0
  };
}

/** What is here right now, so the confirmation can show both sides. */
export async function summariseCurrent(): Promise<BackupSummary> {
  return summarise(await collect());
}

/**
 * Replace everything with the contents of a backup.
 *
 * Destructive by design — this is "restore", not "merge". The caller must
 * have shown the user both summaries and got a yes. Ordering matters: the
 * localStorage database goes in first so that chatStore.repair() has a valid
 * activeProjectId to file any project-less conversation under.
 */
export async function restoreEverything(b: FullBackup): Promise<BackupSummary> {
  /* Backups carry no keys (store.withoutCredentials strips them); store.restoreBackup keeps
     this browser's own, so restoring does not sign you out of your provider. */
  store.restoreBackup(b.db as DrillDB | LegacyDBv3 | LegacyDBv2);

  await Promise.all([
    idbClear(STORE_CONV),
    idbClear(STORE_MEM),
    idbClear(STORE_CAND),
    idbClear(STORE_JOURNAL),
    idbClear(STORE_ROLLUPS),
    idbClear(STORE_EXAMS),
    idbClear(STORE_USAGE)
  ]);
  await Promise.all([
    idbBulkPut(STORE_CONV, b.conversations),
    idbBulkPut(STORE_MEM, b.memories),
    idbBulkPut(STORE_CAND, b.candidates),
    idbBulkPut(STORE_JOURNAL, b.journal),
    idbBulkPut(STORE_ROLLUPS, b.rollups),
    idbBulkPut(STORE_EXAMS, b.exams),
    idbBulkPut(STORE_USAGE, b.usage)
  ]);
  /* Files only when the backup carries them. One made without them leaves
     this browser's own copies where they are rather than emptying the store,
     so a restored conversation pointing at a picture still here can show it. */
  if (b.files?.length) {
    await filesDb.replaceAll(
      b.files.map((f) => ({ id: f.id, name: f.name, mime: f.mime, size: f.size, created: f.created, blob: base64ToBlob(f.data, f.mime) }))
    );
  }
  /* Boards, unlike files, are replaced whenever the backup carries the field
     at all — including empty, which is what "this browser had no boards when
     I exported" means. A backup from before boards leaves them alone. */
  if (Array.isArray(b.boards)) await filesDb.replaceAllBoards(b.boards as never);
  await Promise.all([
    chatStore.rebuildIndex(),
    memoryStore.reload(),
    candidates.reload(),
    journalStore.reload(),
    examStore.reload(),
    usageLog.reload()
  ]);

  return summarise(b);
}

/** parse + restore, for the common path. */
export async function restoreFromText(text: string): Promise<BackupSummary> {
  return restoreEverything(parse(text));
}
