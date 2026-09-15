import test from "node:test";
import assert from "node:assert/strict";
import { dayStart, groupByWeek, partLabel, weekLabel, weekStart } from "@/lib/weeks";

const ymd = (d: Date | null) => (d ? `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}` : null);

test("weeks start on Monday", () => {
  /* 14 September 2026 is a Monday. */
  assert.equal(ymd(weekStart("2026-9-14")), "2026-9-14");
  assert.equal(ymd(weekStart("2026-9-15")), "2026-9-14");
  assert.equal(ymd(weekStart("2026-09-20")), "2026-9-14", "Sunday belongs to the week it ends");
  assert.equal(ymd(weekStart("2026-9-13")), "2026-9-7", "and not to the one after it");
});

test("padded and unpadded day keys are the same day, and nonsense is nothing", () => {
  assert.equal(ymd(dayStart("2026-03-04")), ymd(dayStart("2026-3-4")));
  assert.equal(dayStart("last tuesday"), null);
  assert.equal(dayStart(""), null);
});

test("a week can start in the previous year", () => {
  assert.equal(ymd(weekStart("2026-1-1")), "2025-12-29");
});

test("the label carries the year only when it is not this one", () => {
  const now = new Date(2026, 8, 15);
  assert.equal(weekLabel(new Date(2026, 8, 7), now), "Week of 7 September");
  assert.equal(weekLabel(new Date(2025, 11, 29), now), "Week of 29 December 2025");
});

test("entries group by week, oldest week first, days in real order", () => {
  const entries = [
    { day: "2026-9-15", id: "tue-next" },
    { day: "2026-9-10", id: "thu" },
    { day: "2026-9-9", id: "wed" },
    { day: "2026-9-14", id: "mon-next" }
  ];
  const weeks = groupByWeek(entries, new Date(2026, 8, 15));
  assert.equal(weeks.length, 2);
  assert.equal(weeks[0].label, "Week of 7 September");
  /* "2026-9-10" sorts before "2026-9-9" as a string; as days it comes after. */
  assert.deepEqual(weeks[0].items.map((e) => e.id), ["wed", "thu"]);
  assert.deepEqual(weeks[1].items.map((e) => e.id), ["mon-next", "tue-next"]);
});

test("a week ends one millisecond before the next one starts", () => {
  const [w] = groupByWeek([{ day: "2026-9-9" }]);
  assert.equal(w.end + 1, new Date(2026, 8, 14).getTime());
  assert.equal(w.start, new Date(2026, 8, 7).getTime());
});

test("a second rollup of the same week is a part, not a duplicate heading", () => {
  assert.equal(partLabel("Week of 7 September", []), "Week of 7 September");
  assert.equal(partLabel("Week of 7 September", ["Week of 7 September"]), "Week of 7 September (part 2)");
  assert.equal(
    partLabel("Week of 7 September", ["Week of 7 September", "Week of 7 September (part 2)", "Week of 31 August"]),
    "Week of 7 September (part 3)"
  );
});
