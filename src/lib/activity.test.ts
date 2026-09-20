/* ============================================================================
 * activity.test.ts — a day counts if anything happened in it.
 *
 * These exist because the calendar and the streak used to read `db.log` alone,
 * so five of the six sections were invisible to the one page that reports on
 * all of them: an evening of journal, chat and an exam drew a blank square and
 * broke a streak. The rules worth pinning down are the ones that make that
 * impossible to reintroduce — every kind contributes, showing up is always
 * visible, and a day's mix survives the trip to the grid.
 *
 * Dates are built relative to "now" rather than hardcoded, because the whole
 * module is about *local* calendar days and a fixed timestamp would pass in
 * one timezone and fail in another.
 * ========================================================================== */
import test from "node:test";
import assert from "node:assert/strict";
import {
  ACTIVITY_KINDS,
  daysFrom,
  describeDay,
  emptySource,
  grid,
  levelFor,
  monthLabels,
  streaks,
  today,
  totalOf,
  week,
  type ActivityKind,
  type ActivitySource
} from "@/lib/activity";
import { dayKey } from "@/lib/util";

/** Midday `n` days ago, local — midday so a timezone offset cannot push a
 *  fixture over a day boundary and make the test lie. */
function daysAgo(n: number): number {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(12, 0, 0, 0);
  return d.getTime();
}

function src(spec: Partial<Record<ActivityKind, number[]>>): ActivitySource {
  return { ...emptySource(), ...spec };
}

test("every kind of work counts as activity", () => {
  /* The bug, stated as a test: one thing done in each section, on its own
     day, and every one of those days must be an active day. */
  const days = daysFrom(
    src(Object.fromEntries(ACTIVITY_KINDS.map((k, i) => [k, [daysAgo(i)]]))) as ActivitySource
  );
  assert.equal(days.size, ACTIVITY_KINDS.length);
  for (const [, day] of days) assert.equal(day.total, 1);
});

test("a day with no reviews in it is still a day", () => {
  /* The exact evening that used to read as nothing: journal, chat, an exam. */
  const days = daysFrom(src({ journal: [daysAgo(0)], chat: [daysAgo(0)], exam: [daysAgo(0)] }));
  const t = today(days);
  assert.equal(t.total, 3);
  assert.equal(t.by.review, 0);
  assert.equal(streaks(days).current, 1);
});

test("a day keeps the mix it was made of", () => {
  const days = daysFrom(src({ review: [daysAgo(1), daysAgo(1), daysAgo(1)], card: [daysAgo(1)] }));
  const day = days.get(dayKey(daysAgo(1)))!;
  assert.equal(day.total, 4);
  assert.equal(day.by.review, 3);
  assert.equal(day.by.card, 1);
  assert.equal(day.by.journal, 0);
});

test("showing up is always visible, however light the day", () => {
  /* Against a 200-review day, one journal entry is 0.5% — and under the old
     rule that still had to render as *something*, or the calendar becomes a
     chart of your heaviest days rather than a record of your habit. */
  assert.equal(levelFor(1, 200), 1);
  assert.equal(levelFor(0, 200), 0, "and nothing still reads as nothing");
  assert.equal(levelFor(200, 200), 4);
  assert.equal(levelFor(1, 1), 4, "a first day is not a faint one");
});

test("the grid carries each day's breakdown out to the tooltip", () => {
  const days = daysFrom(src({ review: [daysAgo(0), daysAgo(0)], journal: [daysAgo(0)] }));
  const cells = grid(days, 4).flat();
  const cell = cells.find((c) => c.key === dayKey(daysAgo(0)));
  assert.ok(cell, "today must be in the grid");
  assert.equal(cell.count, 3);
  assert.equal(cell.by.review, 2);
  assert.equal(cell.by.journal, 1);
  assert.equal(cell.future, false);
});

test("the grid is rectangular and only the future is hollow", () => {
  const cols = grid(daysFrom(emptySource()), 6);
  assert.equal(cols.length, 6);
  for (const col of cols) assert.equal(col.length, 7);

  const flat = cols.flat();
  const todayCell = flat.find((c) => c.key === dayKey());
  assert.ok(todayCell && !todayCell.future, "today is not the future");
  /* Everything after today is padding and must never be drawn as activity. */
  for (const c of flat) if (c.future) assert.equal(c.count, 0);
});

test("month labels never collide and never land on the last column", () => {
  const cols = grid(daysFrom(emptySource()), 53);
  const labels = monthLabels(cols);
  assert.ok(labels.length >= 8, "a year should name most of its months");
  for (let i = 1; i < labels.length; i++) {
    assert.ok(labels[i].col - labels[i - 1].col >= 3, "two labels closer than three columns would overprint");
  }
  assert.ok(labels.every((l) => l.col < cols.length - 1));
});

test("today unfinished does not break a streak; a blank day behind you does", () => {
  /* Yesterday and the day before worked, nothing yet today: the run stands at
     two, because today has not failed — it has not happened. */
  const going = daysFrom(src({ note: [daysAgo(1), daysAgo(2)] }));
  assert.equal(streaks(going).current, 2);

  /* A gap two days back ends it there. */
  const broken = daysFrom(src({ note: [daysAgo(1), daysAgo(3)] }));
  assert.equal(streaks(broken).current, 1);
});

test("the longest run is found even when it is not the current one", () => {
  const days = daysFrom(src({ review: [daysAgo(10), daysAgo(9), daysAgo(8), daysAgo(7), daysAgo(1)] }));
  const { current, longest, activeDays } = streaks(days);
  assert.equal(longest, 4);
  assert.equal(current, 1);
  assert.equal(activeDays, 5);
});

test("nothing at all is zero everywhere rather than undefined anywhere", () => {
  const days = daysFrom(emptySource());
  assert.equal(days.size, 0);
  assert.equal(totalOf(days), 0);
  assert.deepEqual(streaks(days), { current: 0, longest: 0, activeDays: 0 });
  assert.equal(today(days).total, 0);
  assert.equal(week(days).total, 0);
  assert.deepEqual(week(days).active, Array(7).fill(false));
});

test("the week ends today and runs seven days", () => {
  const days = daysFrom(src({ chat: [daysAgo(0)], review: [daysAgo(6)] }));
  const w = week(days);
  assert.equal(w.active.length, 7);
  assert.equal(w.active[6], true, "the last slot is today");
  assert.equal(w.active[0], true, "the first slot is six days back");
  assert.equal(w.total, 2);
  /* Seven days back is outside the window, however much was done. */
  assert.equal(week(daysFrom(src({ review: [daysAgo(7)] }))).total, 0);
});

test("a day is described in words, singular and plural, and only what happened", () => {
  const one = daysFrom(src({ review: [daysAgo(0)], journal: [daysAgo(0)] }));
  const text = describeDay(today(one));
  assert.match(text, /1 card reviewed/);
  assert.match(text, /1 journal entry/);
  assert.doesNotMatch(text, /0 /, "kinds with nothing in them are left out, not printed as zeroes");

  const many = daysFrom(src({ review: [daysAgo(0), daysAgo(0)] }));
  assert.match(describeDay(today(many)), /2 cards reviewed/);
  assert.equal(describeDay(undefined), "nothing logged");
});

test("a long day is truncated rather than allowed to run off a tooltip", () => {
  const busy = daysFrom(src(Object.fromEntries(ACTIVITY_KINDS.map((k) => [k, [daysAgo(0)]]))) as ActivitySource);
  const text = describeDay(today(busy), 3);
  /* Counted off the list rather than written down: this said "+4 more" until
     the day a kind was added, at which point the assertion failed for the one
     reason that was not a bug. */
  assert.ok(text.endsWith(`+${ACTIVITY_KINDS.length - 3} more`), text);
  assert.equal(describeDay(today(busy)).includes("more"), false, "and is complete when it is allowed to be");
});

test("every kind has a label, and no label is a placeholder", () => {
  /* A kind added without a label would render as "3 undefined" in a tooltip
     and in the today strip. */
  const busy = daysFrom(src(Object.fromEntries(ACTIVITY_KINDS.map((k) => [k, [daysAgo(0)]]))) as ActivitySource);
  const text = describeDay(today(busy));
  assert.doesNotMatch(text, /undefined/);
  for (const k of ACTIVITY_KINDS) assert.ok(text.length > k.length);
});
