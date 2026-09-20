/* ============================================================================
 * activity.ts — the project's days, from everything that happens in one.
 *
 * This read `db.log` alone until 2026-09-10, which meant "activity" meant
 * "cards graded" and nothing else did. Spend an evening writing the journal,
 * working through a conversation, sitting an exam and turning three answers
 * into cards, and the calendar showed a blank square and the streak broke —
 * an app telling you that a productive day did not happen. Five of the six
 * sections were invisible to the one page that reports on all of them.
 *
 * So a day is now a *mix*, and every section contributes to it. What a day
 * holds is derived at read time from the stores that already own it — nothing
 * is written down twice, so a day can never disagree with the section it came
 * from, and history that predates this file counts retroactively.
 *
 * Still pure: no DOM, no React, no services. services/activity.ts gathers the
 * timestamps, this turns them into days, weeks and streaks, and
 * activity.test.ts holds it to both.
 *
 * A day is a local calendar day — the same dayKey() the session and the
 * rollover use — because a streak measured in UTC would break for anyone who
 * studies in the evening.
 * ========================================================================== */
import { dayKey } from "@/lib/util";

/** Every section, plus the things they make. Ordered as a day reads: what you
 *  drilled, what you made of it, what you wrote, who you asked, what you were
 *  tested on, what was remembered, what you kept. */
export const ACTIVITY_KINDS = ["review", "card", "note", "journal", "chat", "exam", "memory", "figure"] as const;

export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** Singular and plural, for a sentence rather than a legend. */
export const KIND_LABEL: Record<ActivityKind, [string, string]> = {
  review: ["card reviewed", "cards reviewed"],
  card: ["card written", "cards written"],
  note: ["note logged", "notes logged"],
  journal: ["journal entry", "journal entries"],
  chat: ["conversation", "conversations"],
  exam: ["exam", "exams"],
  memory: ["memory saved", "memories saved"],
  figure: ["figure kept", "figures kept"]
};

/** Every timestamp the project produced, by kind. Built by
 *  services/activity.ts; kept as plain numbers so this file stays testable
 *  without a single store. */
export type ActivitySource = Record<ActivityKind, number[]>;

export function emptySource(): ActivitySource {
  return { review: [], card: [], note: [], journal: [], chat: [], exam: [], memory: [], figure: [] };
}

export interface DayActivity {
  key: string;
  /** Everything that happened that day, added up. */
  total: number;
  by: Record<ActivityKind, number>;
}

function blankCounts(): Record<ActivityKind, number> {
  return { review: 0, card: 0, note: 0, journal: 0, chat: 0, exam: 0, memory: 0, figure: 0 };
}

/* Days are stepped with the calendar, never with `+ 86400000`. Adding a fixed
   number of milliseconds drifts by an hour across a daylight-saving boundary,
   which is enough to put a column on the wrong weekday or silently break a
   streak twice a year. */
function midnight(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function addDays(ts: number, n: number): number {
  const d = new Date(ts);
  d.setDate(d.getDate() + n);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function parseDayKey(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).setHours(0, 0, 0, 0);
}

export interface DayCell {
  /** Local midnight of the day. */
  ts: number;
  key: string;
  /** Everything done that day. Named `count` because that is what the grid
   *  draws; `by` is the same number broken out. */
  count: number;
  by: Record<ActivityKind, number>;
  /** 0-4. Zero is "nothing"; anything at all is at least 1, so a day you
   *  showed up on is never drawn as a day you did not. */
  level: number;
  /** Days after today, padding out the last week. Drawn as holes. */
  future: boolean;
}

/** Everything, by local day. */
export function daysFrom(src: ActivitySource): Map<string, DayActivity> {
  const out = new Map<string, DayActivity>();
  for (const kind of ACTIVITY_KINDS) {
    for (const ts of src[kind]) {
      const key = dayKey(ts);
      let day = out.get(key);
      if (!day) {
        day = { key, total: 0, by: blankCounts() };
        out.set(key, day);
      }
      day.by[kind]++;
      day.total++;
    }
  }
  return out;
}

/**
 * Level 1 is not a quarter of the busiest day — it is "anything".
 *
 * The old rule scaled every step against the maximum, so on a week with one
 * 200-review day, a day with a journal entry and two cards on it landed at
 * the same shade as a day with nothing. Showing up has to be visible, or the
 * calendar is a chart of your heaviest days rather than a record of your
 * habit, which is the only thing it is for.
 */
export function levelFor(count: number, max: number): number {
  if (count <= 0) return 0;
  if (max <= 1) return 4;
  const t = count / max;
  if (t <= 0.25) return 1;
  if (t <= 0.5) return 2;
  if (t <= 0.75) return 3;
  return 4;
}

/**
 * `weeks` columns of seven days, oldest first, each column Sunday→Saturday —
 * the GitHub shape. The last column contains today, and the days after it are
 * marked `future` so the grid stays rectangular without inventing activity.
 */
export function grid(days: Map<string, DayActivity>, weeks = 53): DayCell[][] {
  const todayMid = midnight(Date.now());
  // Walk back to the Sunday of the current week, then back `weeks - 1` more.
  const startOfWeek = addDays(todayMid, -new Date(todayMid).getDay());
  const start = addDays(startOfWeek, -(weeks - 1) * 7);

  let max = 0;
  const raw: { ts: number; key: string; count: number; by: Record<ActivityKind, number> }[] = [];
  for (let i = 0; i < weeks * 7; i++) {
    const ts = addDays(start, i);
    const key = dayKey(ts);
    const day = ts > todayMid ? undefined : days.get(key);
    const count = day?.total || 0;
    if (count > max) max = count;
    raw.push({ ts, key, count, by: day ? day.by : blankCounts() });
  }

  const out: DayCell[][] = [];
  for (let w = 0; w < weeks; w++) {
    const col: DayCell[] = [];
    for (let d = 0; d < 7; d++) {
      const r = raw[w * 7 + d];
      col.push({ ...r, level: levelFor(r.count, max), future: r.ts > todayMid });
    }
    out.push(col);
  }
  return out;
}

/** Month names to print above the grid, one per column where that column is
 *  the first of its month. Returns [columnIndex, label] pairs. */
export function monthLabels(cols: DayCell[][]): { col: number; label: string }[] {
  const out: { col: number; label: string }[] = [];
  let last = -1;
  let lastCol = -99;
  cols.forEach((col, i) => {
    const m = new Date(col[0].ts).getMonth();
    // Two labels three columns apart collide — the first week of a month can
    // be a stub of one or two days, and printing "Aug Sep" on top of each
    // other is worse than dropping the stub.
    if (m !== last && i - lastCol >= 3 && i < cols.length - 1) {
      out.push({ col: i, label: new Date(col[0].ts).toLocaleDateString(undefined, { month: "short" }) });
      last = m;
      lastCol = i;
    }
  });
  return out;
}

/**
 * Current and longest run of consecutive active days.
 *
 * Today not being done yet does not break the streak — it has not happened
 * yet. A day with nothing at all on it, once it is behind you, does. What
 * counts as "nothing" is now everything: a day you only wrote the journal
 * keeps a streak that used to need a card graded before midnight.
 */
export function streaks(days: Map<string, DayActivity>): {
  current: number;
  longest: number;
  activeDays: number;
} {
  const active = (ts: number) => (days.get(dayKey(ts))?.total || 0) > 0;
  const todayMid = midnight(Date.now());

  let current = 0;
  let cursor = active(todayMid) ? todayMid : addDays(todayMid, -1);
  while (active(cursor)) {
    current++;
    cursor = addDays(cursor, -1);
  }

  const list = [...days.keys()].map(parseDayKey).sort((a, b) => a - b);
  let longest = 0;
  let run = 0;
  let prev = 0;
  for (const t of list) {
    run = prev && t === addDays(prev, 1) ? run + 1 : 1;
    if (run > longest) longest = run;
    prev = t;
  }

  return { current, longest, activeDays: days.size };
}

/** What one day held, for a tooltip or a sentence: "12 cards reviewed · 3
 *  cards written · a journal entry". Kinds with nothing in them are left out
 *  rather than printed as zeroes. */
export function describeDay(day: DayActivity | undefined, limit: number = ACTIVITY_KINDS.length): string {
  if (!day || !day.total) return "nothing logged";
  const parts: string[] = [];
  for (const kind of ACTIVITY_KINDS) {
    const n = day.by[kind];
    if (!n) continue;
    const [one, many] = KIND_LABEL[kind];
    parts.push(`${n} ${n === 1 ? one : many}`);
  }
  if (parts.length <= limit) return parts.join(" · ");
  return parts.slice(0, limit).join(" · ") + ` · +${parts.length - limit} more`;
}

/** The day as it stands right now, or an empty one. */
export function today(days: Map<string, DayActivity>): DayActivity {
  return days.get(dayKey()) || { key: dayKey(), total: 0, by: blankCounts() };
}

/** Total across the map — what the whole calendar adds up to. */
export function totalOf(days: Map<string, DayActivity>): number {
  let n = 0;
  for (const d of days.values()) n += d.total;
  return n;
}

/** Seven booleans and a total, oldest first, ending today. The shape both
 *  rails draw their week from, so they cannot disagree about it. */
export function week(days: Map<string, DayActivity>): { active: boolean[]; total: number } {
  const todayMid = midnight(Date.now());
  const active: boolean[] = [];
  let total = 0;
  for (let i = 6; i >= 0; i--) {
    const n = days.get(dayKey(addDays(todayMid, -i)))?.total || 0;
    active.push(n > 0);
    total += n;
  }
  return { active, total };
}
