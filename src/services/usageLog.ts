/* ============================================================================
 * usageLog.ts — what the models actually cost, kept across reloads.
 *
 * services/transcript.ts answers "what is it doing right now" and is
 * deliberately in-memory, capped and disposable. This answers the different
 * question "what have I spent", which is only useful if it survives a reload.
 *
 * One record per day, not one per call: a row per call would grow without
 * bound for a number nobody reads at that resolution. Within a day, spend is
 * bucketed by backend|model|feature, which is the grain the panel displays.
 *
 * Cost is frozen at write time from the price then in effect. Prices move;
 * history should not. A row whose model had no known price keeps `cost:
 * undefined` forever — unknown is not zero, and summing must preserve that.
 *
 * Reading replies aloud is counted here too, under the label "listen". A
 * speech call bills by the character and reports no tokens at all, so rows
 * carry `characters` beside the token counts — without it an unpriced voice
 * would be a row of zeros that looked exactly like a free one.
 * ========================================================================== */
import { STORE_USAGE, idbAll, idbClear, idbPut } from "./idb";
import * as persistence from "./persistence";
import type { TokenUsage } from "@/types";

export interface UsageRow {
  backend: string;
  model: string;
  /** "chat" · "cards" · "journal" · "distill" · "exam grading" · "listen" … */
  label: string;
  calls: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
  reasoningTokens: number;
  /** Characters sent to be read aloud. Zero for everything that is not. */
  characters: number;
  /** Pictures generated. Zero for everything that is not, and here for the
   *  reason `characters` is: a picture is billed per picture and reports no
   *  tokens, so without a count of its own an image call is a row of zeros
   *  that reads as a free one. */
  images: number;
  /** undefined = no price was known, which is not the same as free. */
  cost?: number;
}

export interface UsageDay {
  /** Zero-padded and therefore sortable: "2026-09-03". */
  day: string;
  /** Local midnight, epoch ms. Range queries filter on this rather than on
   *  the string, so they cannot be tripped up by formatting. */
  at: number;
  rows: Record<string, UsageRow>;
}

export interface UsageTotals {
  calls: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
  reasoningTokens: number;
  characters: number;
  images: number;
  cost?: number;
  /** Models seen with no known price, so the panel can say so rather than
   *  letting a blank column read as free. */
  unpriced: string[];
}

/* --------------------------------------------------------------- day keys */

/* lib/util's dayKey is not zero-padded, so its output does not sort. This
   ledger is range-queried and ordered, so it uses its own padded key. */
function pad(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

export function dayOf(ts: number): string {
  const d = new Date(ts);
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

function midnightOf(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function keyOf(backend: string, model: string, label: string): string {
  return backend + "|" + model + "|" + label;
}

/* ------------------------------------------------------------------ state */

let days = new Map<string, UsageDay>();
let loaded = false;
let version = 0;
const listeners = new Set<() => void>();
const pending = new Map<string, ReturnType<typeof setTimeout>>();

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

/* ------------------------------------------------------------------- load */

export async function init(): Promise<void> {
  if (loaded) return;
  try {
    const all = await idbAll<UsageDay>(STORE_USAGE);
    days = new Map(all.filter((d) => d && d.day).map((d) => [d.day, repair(d)]));
  } catch {
    /* No ledger is a survivable state; spending still works. */
    days = new Map();
  }
  loaded = true;
  notify();
}

/** Forward-migration on read, the same shape chatStore.repair uses: a record
 *  written before a field existed reads back with it zeroed. */
function repair(d: UsageDay): UsageDay {
  if (!d.rows) d.rows = {};
  if (!d.at) {
    /* Parsed by parts, not Date.parse: "2026-09-03" parses as UTC midnight,
       which lands on the previous day west of Greenwich. */
    const [y, m, dd] = d.day.split("-").map(Number);
    d.at = y && m && dd ? new Date(y, m - 1, dd).getTime() : midnightOf(Date.now());
  }
  for (const k of Object.keys(d.rows)) {
    const r = d.rows[k];
    r.calls ||= 0;
    r.errors ||= 0;
    r.promptTokens ||= 0;
    r.completionTokens ||= 0;
    r.cachedPromptTokens ||= 0;
    r.reasoningTokens ||= 0;
    r.characters ||= 0;
    r.images ||= 0;
  }
  return d;
}

/* ------------------------------------------------------------------ write */

function persist(day: string): void {
  const t = pending.get(day);
  if (t) clearTimeout(t);
  pending.set(
    day,
    setTimeout(() => {
      pending.delete(day);
      const rec = days.get(day);
      if (rec) void persistence.guard("usage record", idbPut(STORE_USAGE, rec));
    }, 400)
  );
}

/** Force queued writes out — tab hide, so the last reply before you closed
 *  the tab still counts. */
export function flushAll(): void {
  for (const [day, t] of pending) {
    clearTimeout(t);
    const rec = days.get(day);
    if (rec) void persistence.guard("usage record", idbPut(STORE_USAGE, rec));
  }
  pending.clear();
}

export interface UsageEntry {
  at: number;
  backend: string;
  model: string;
  label: string;
  usage?: TokenUsage;
  /** Characters synthesised, for a call that read text aloud. */
  characters?: number;
  /** Pictures the reply came back with. */
  images?: number;
  /** Already costed by the caller, which knows the price at the time. */
  cost?: number;
  failed?: boolean;
}

/** Record one AI call. Called from the two seams in services/ai — chat() and
 *  speak() — so every feature is covered without any of them opting in. */
export function add(e: UsageEntry): void {
  const day = dayOf(e.at);
  let rec = days.get(day);
  if (!rec) {
    rec = { day, at: midnightOf(e.at), rows: {} };
    days.set(day, rec);
  }

  const key = keyOf(e.backend, e.model, e.label);
  let row = rec.rows[key];
  if (!row) {
    row = rec.rows[key] = {
      backend: e.backend,
      model: e.model,
      label: e.label,
      calls: 0,
      errors: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedPromptTokens: 0,
      reasoningTokens: 0,
      characters: 0,
      images: 0
    };
  }

  row.calls++;
  if (e.failed) row.errors++;
  row.characters += e.characters || 0;
  row.images += e.images || 0;
  if (e.usage) {
    row.promptTokens += e.usage.promptTokens || 0;
    row.completionTokens += e.usage.completionTokens || 0;
    row.cachedPromptTokens += e.usage.cachedPromptTokens || 0;
    row.reasoningTokens += e.usage.reasoningTokens || 0;
  }
  /* Only start a running cost once something has actually been priced —
     adding to undefined would silently turn unknown into a number. */
  if (e.cost != null) row.cost = (row.cost || 0) + e.cost;

  persist(day);
  notify();
}

/* ------------------------------------------------------------------- read */

/** Days newest first. `sinceDays` of 0 or undefined means everything;
 *  1 means today only. */
export function range(sinceDays?: number): UsageDay[] {
  const all = [...days.values()].sort((a, b) => b.at - a.at);
  if (!sinceDays) return all;
  const from = midnightOf(Date.now()) - (sinceDays - 1) * 86400000;
  return all.filter((d) => d.at >= from);
}

/** Flatten a set of days into one row per group, summed. */
export function rollup(list: UsageDay[], by: (r: UsageRow) => string): UsageRow[] {
  const out = new Map<string, UsageRow>();
  for (const d of list) {
    for (const r of Object.values(d.rows)) {
      const k = by(r);
      const cur = out.get(k);
      if (!cur) {
        out.set(k, { ...r });
        continue;
      }
      cur.calls += r.calls;
      cur.errors += r.errors;
      cur.promptTokens += r.promptTokens;
      cur.completionTokens += r.completionTokens;
      cur.cachedPromptTokens += r.cachedPromptTokens;
      cur.reasoningTokens += r.reasoningTokens;
      cur.characters += r.characters;
      cur.images += r.images || 0;
      if (r.cost != null) cur.cost = (cur.cost || 0) + r.cost;
    }
  }
  return [...out.values()].sort((a, b) => (b.cost || 0) - (a.cost || 0) || b.promptTokens + b.completionTokens - (a.promptTokens + a.completionTokens));
}

export function totals(list: UsageDay[]): UsageTotals {
  const t: UsageTotals = {
    calls: 0,
    errors: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedPromptTokens: 0,
    reasoningTokens: 0,
    characters: 0,
    images: 0,
    unpriced: []
  };
  const unpriced = new Set<string>();
  for (const d of list) {
    for (const r of Object.values(d.rows)) {
      t.calls += r.calls;
      t.errors += r.errors;
      t.promptTokens += r.promptTokens;
      t.completionTokens += r.completionTokens;
      t.cachedPromptTokens += r.cachedPromptTokens;
      t.reasoningTokens += r.reasoningTokens;
      t.characters += r.characters;
      t.images += r.images || 0;
      if (r.cost != null) t.cost = (t.cost || 0) + r.cost;
      /* A row with tokens but no cost is a model we could not price. One
         with no tokens either just never reported usage. A voice reports
         characters instead of tokens, and an unpriced one is just as much a
         blank that must not read as free. */
      else if (r.promptTokens || r.completionTokens || r.characters || r.images) unpriced.add(r.model);
    }
  }
  t.unpriced = [...unpriced];
  return t;
}

/* ------------------------------------------------------------ maintenance */

export async function clear(): Promise<void> {
  for (const t of pending.values()) clearTimeout(t);
  pending.clear();
  days = new Map();
  notify();
  try {
    await idbClear(STORE_USAGE);
  } catch {
    /* ignore */
  }
}

/* ---------------------------------------------------------- backup bridge */

/** Re-read from IndexedDB after a restore has written records underneath us,
 *  the same shape memoryStore.reload/journalStore.reload use. */
export async function reload(): Promise<void> {
  try {
    const all = await idbAll<UsageDay>(STORE_USAGE);
    days = new Map(all.filter((d) => d && d.day).map((d) => [d.day, repair(d)]));
  } catch {
    days = new Map();
  }
  loaded = true;
  notify();
}
