/* ============================================================================
 * weeks.ts — journal entries, grouped into the weeks a rollup is made of.
 *
 * START-HERE §6 describes the rhythm as daily entries rolling up weekly, and
 * §7 gives a rollup the label "Week of 10 March". What shipped instead rolled
 * up everything not yet rolled up — three weeks of entries in one request, if
 * that is how long it had been — labelled "23 entries". That was the other half
 * of why the rollup kept hitting the token cap: its input had no bound at all.
 * One week at a time has one by construction, seven entries a project.
 *
 * Pure. Day keys are parsed rather than trusted to sort as strings: lib/util's
 * dayKey writes "2026-9-8", unpadded, so "2026-9-10" sorts before "2026-9-9".
 * ========================================================================== */

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December"
];

export interface WeekGroup<T> {
  /** The Monday's own day key — stable, for React keys and comparisons. */
  key: string;
  /** "Week of 8 September", with the year only when it is not this one. */
  label: string;
  /** Local midnight on the Monday, and the last millisecond of the Sunday. */
  start: number;
  end: number;
  /** Oldest day first. */
  items: T[];
}

/** Local midnight of a day key, padded or not. Null for anything else. */
export function dayStart(day: string): Date | null {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(day || "").trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The Monday that starts the week containing this day. Built from the date's
 *  fields rather than by subtracting milliseconds, so a week that crosses a
 *  clock change still starts at midnight. */
export function weekStart(day: string): Date | null {
  const d = dayStart(day);
  if (!d) return null;
  const back = (d.getDay() + 6) % 7;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back);
}

/** English by construction rather than by locale, because this label is stored
 *  on the rollup and read back as a heading — it must not change with the
 *  browser it happens to be written in. */
export function weekLabel(start: Date, now: Date = new Date()): string {
  const base = `Week of ${start.getDate()} ${MONTHS[start.getMonth()]}`;
  return start.getFullYear() === now.getFullYear() ? base : `${base} ${start.getFullYear()}`;
}

export function groupByWeek<T extends { day: string }>(items: T[], now: Date = new Date()): WeekGroup<T>[] {
  const byKey = new Map<string, WeekGroup<T>>();
  for (const it of items) {
    const start = weekStart(it.day);
    if (!start) continue;
    const key = `${start.getFullYear()}-${start.getMonth() + 1}-${start.getDate()}`;
    let g = byKey.get(key);
    if (!g) {
      const next = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
      g = { key, label: weekLabel(start, now), start: start.getTime(), end: next.getTime() - 1, items: [] };
      byKey.set(key, g);
    }
    g.items.push(it);
  }
  const at = (day: string) => dayStart(day)?.getTime() ?? 0;
  const out = [...byKey.values()].sort((a, b) => a.start - b.start);
  for (const g of out) g.items.sort((a, b) => at(a.day) - at(b.day));
  return out;
}

/**
 * The label a new rollup should carry, given the ones already written.
 *
 * Weekly is a default, not a rule (START-HERE §6): a week can be rolled up on
 * its Wednesday and again on its Sunday for the days that came after. Two
 * headings reading "Week of 8 September" would look like a duplicate.
 */
export function partLabel(label: string, existing: string[]): string {
  const n = existing.filter((l) => l === label || l.startsWith(label + " (part ")).length;
  return n ? `${label} (part ${n + 1})` : label;
}
