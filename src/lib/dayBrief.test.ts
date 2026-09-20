/* ============================================================================
 * dayBrief.test.ts — the window, which is the part that can be wrong quietly.
 *
 * The day brief goes two places now: the model, on every message, where a
 * mistake is a wrong answer you would notice; and the journal writer, where a
 * mistake is written into a permanent record you would not. Writing up
 * yesterday while handed a window that ends "now" files this morning's reviews
 * under yesterday's date, in the one record whose entire promise is that it is
 * what happened — and nothing about the entry would look wrong afterwards.
 *
 * So: a closed day is closed at both ends.
 * ========================================================================== */
import test from "node:test";
import assert from "node:assert/strict";
import { dayWindow, todayWindow } from "@/lib/dayBrief";
import { dayKey, today, DAY } from "@/lib/util";

function midnight(ts = Date.now()): number {
  return new Date(ts).setHours(0, 0, 0, 0);
}

test("a past day ends at its own midnight, not at now", () => {
  const yesterday = dayKey(Date.now() - DAY);
  const w = dayWindow(yesterday);
  assert.ok(w, "yesterday should parse");
  assert.ok(w!.to <= midnight(), "the window must close before today starts");
  assert.equal(w!.live, false);
  assert.equal(w!.label, yesterday);
});

test("a day is exactly one day long", () => {
  const w = dayWindow("2026-3-14");
  assert.ok(w);
  const start = new Date(2026, 2, 14).getTime();
  assert.equal(w!.from, start);
  assert.equal(w!.to, new Date(2026, 2, 15).getTime());
});

test("today is live and runs to now", () => {
  const w = dayWindow(today());
  assert.ok(w);
  assert.equal(w!.live, true);
  assert.equal(w!.label, "today");
  assert.equal(w!.from, midnight());
});

test("a day key that will not parse is no window at all", () => {
  /* Rather than a window around the epoch, which would collect nothing and
     look exactly like an empty day. */
  assert.equal(dayWindow("not-a-day"), null);
  assert.equal(dayWindow(""), null);
});

test("chat's window is the last n days ending now", () => {
  assert.equal(todayWindow(1).from, midnight());
  assert.equal(todayWindow(7).from, midnight() - 6 * DAY);
  assert.ok(todayWindow(1).to > Date.now() - 1000);
  assert.equal(todayWindow(1).live, true);
  /* Zero and negatives are a caller's mistake, not a window of nothing. */
  assert.equal(todayWindow(0).from, midnight());
});
