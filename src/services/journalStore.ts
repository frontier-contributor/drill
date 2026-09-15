/* ============================================================================
 * journalStore.ts — daily entries and their weekly rollups: CRUD,
 * persistence, and the subscription React binds to.
 *
 * Same shape as chatStore.ts / memoryStore.ts (module singleton, sync cache
 * over IndexedDB) so the journal view and the chat context builder can both
 * read it without an await.
 * ========================================================================== */
import * as U from "@/lib/util";
import { idbAll, idbDelete, idbPut, STORE_JOURNAL, STORE_ROLLUPS } from "./idb";
import * as persistence from "./persistence";
import { groupByWeek, type WeekGroup } from "@/lib/weeks";
import type { JournalEntry, JournalSummary, PeriodRollup, RawLog } from "@/types/journal";

let entries: JournalEntry[] = [];
let rollups: PeriodRollup[] = [];
let loaded = false;
let version = 0;
const listeners = new Set<() => void>();

function notify() {
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
  try {
    [entries, rollups] = await Promise.all([idbAll<JournalEntry>(STORE_JOURNAL), idbAll<PeriodRollup>(STORE_ROLLUPS)]);
  } catch (e) {
    console.error("could not load journal", e);
    entries = [];
    rollups = [];
  }
  loaded = true;
  notify();
}

function persistEntry(e: JournalEntry): void {
  e.updated = Date.now();
  void persistence.guard("journal entry", idbPut(STORE_JOURNAL, e));
  notify();
}

/* ------------------------------------------------------------------ reads */

export function listForProject(projectId: string): JournalEntry[] {
  return entries.filter((e) => e.projectId === projectId).sort((a, b) => b.day.localeCompare(a.day));
}

export function get(id: string): JournalEntry | undefined {
  return entries.find((e) => e.id === id);
}

export function byDay(projectId: string, day: string): JournalEntry | undefined {
  return entries.find((e) => e.projectId === projectId && e.day === day);
}

/** Entries whose narrative has never been folded into a weekly rollup. */
export function unrolledEntries(projectId: string): JournalEntry[] {
  return listForProject(projectId).filter((e) => !e.rolledUpIn && e.summary);
}

/** The same entries grouped by the week they belong to, oldest week first.
 *  One group is what one rollup call is made of — see lib/weeks.ts for why
 *  that bound exists. */
export function unrolledWeeks(projectId: string): WeekGroup<JournalEntry>[] {
  return groupByWeek(unrolledEntries(projectId));
}

/* -------------------------------------------------------------- mutation */

export function getOrCreateToday(projectId: string): JournalEntry {
  const day = U.today();
  const existing = byDay(projectId, day);
  if (existing) return existing;
  const now = Date.now();
  const e: JournalEntry = {
    id: U.uuid(),
    projectId,
    day,
    created: now,
    updated: now,
    raw: [],
    summary: null,
    edited: false,
    distilled: { at: null, memoryIds: [], cardIds: [] },
    rolledUpIn: null
  };
  entries.push(e);
  persistEntry(e);
  return e;
}

/** Append-only: logging twice in a day adds a second RawLog rather than
 *  overwriting the first. Never calls the API — this is the zero-friction,
 *  zero-cost half of the loop. */
export function appendRaw(entry: JournalEntry, via: RawLog["via"], label: string, text: string): void {
  const clean = text.trim();
  if (!clean) return;
  entry.raw.push({ id: U.uuid(), at: Date.now(), via, label, text: clean });
  persistEntry(entry);
}

export function setSummary(entry: JournalEntry, summary: JournalSummary): void {
  entry.summary = summary;
  entry.edited = false;
  persistEntry(entry);
}

export function editSummary(entry: JournalEntry, patch: Partial<JournalSummary>): void {
  if (!entry.summary) return;
  entry.summary = { ...entry.summary, ...patch };
  entry.edited = true;
  persistEntry(entry);
}

export function markDistilled(entry: JournalEntry, memoryIds: string[], cardIds: string[]): void {
  entry.distilled = {
    at: Date.now(),
    memoryIds: [...entry.distilled.memoryIds, ...memoryIds],
    cardIds: [...entry.distilled.cardIds, ...cardIds]
  };
  persistEntry(entry);
}

export function remove(id: string): void {
  entries = entries.filter((e) => e.id !== id);
  void persistence.guard("journal entry", idbDelete(STORE_JOURNAL, id));
  notify();
}

/* ---------------------------------------------------------------- rollups */

export function listRollups(projectId: string): PeriodRollup[] {
  return rollups.filter((r) => r.projectId === projectId).sort((a, b) => b.to - a.to);
}

export function createRollup(input: Omit<PeriodRollup, "id" | "created">): PeriodRollup {
  const r: PeriodRollup = { ...input, id: U.uuid(), created: Date.now() };
  rollups.push(r);
  void persistence.guard("rollup", idbPut(STORE_ROLLUPS, r));
  for (const eid of input.entryIds) {
    const e = get(eid);
    if (e) {
      e.rolledUpIn = r.id;
      void persistence.guard("journal entry", idbPut(STORE_JOURNAL, e));
    }
  }
  notify();
  return r;
}
