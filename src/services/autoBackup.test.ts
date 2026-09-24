/* ============================================================================
 * autoBackup.test.ts — pruning deletes files from a folder the learner chose.
 *
 * That folder may hold anything: their manual downloads, a backup from
 * another machine, unrelated work. The rotation may remove only the daily
 * snapshots it wrote itself, and only the oldest of those. A mistake here
 * deletes backups — the one thing that exists so nothing is ever lost — with
 * nothing on screen to say so.
 * ========================================================================== */
import test from "node:test";
import assert from "node:assert/strict";
import { autoName, toPrune } from "@/services/autoBackup";

test("only the oldest of its own snapshots are pruned", () => {
  const names = [
    "drill-auto-2026-09-20.json",
    "drill-auto-2026-09-24.json",
    "drill-auto-2026-09-22.json",
    "drill-auto-2026-09-21.json",
    "drill-auto-2026-09-23.json"
  ];
  assert.deepEqual(toPrune(names, 3).sort(), ["drill-auto-2026-09-20.json", "drill-auto-2026-09-21.json"]);
});

test("nothing that is not an auto snapshot is ever on the list", () => {
  const names = [
    "drill-backup-2020-01-01.json", // a manual download, older than everything
    "drill-auto-2020-01-01.json.bak",
    "my-drill-auto-2020-01-01.json",
    "drill-auto-2020-1-1.json", // not the zero-padded name this writes
    "notes.txt",
    "drill-auto-2026-09-24.json"
  ];
  assert.deepEqual(toPrune(names, 1), []);
  assert.deepEqual(toPrune(names, 0), [], "keep 0 means keep everything");
});

test("the name it writes is the name it prunes by, and sorts by date", () => {
  const jan = autoName(new Date(2027, 0, 5));
  const dec = autoName(new Date(2026, 11, 31));
  assert.equal(jan, "drill-auto-2027-01-05.json");
  assert.deepEqual(toPrune([jan, dec], 1), [dec], "a new year is newer, not smaller");
});
