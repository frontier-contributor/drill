/* ============================================================================
 * activity.ts — what a project has actually had happen in it.
 *
 * The one place that reads across every section at once, and the answer to
 * a question the app could not previously answer: "was today a day I did
 * something?" It used to be able to answer only "did I grade a card", because
 * db.log was the sole input to the calendar and the streak — so an evening of
 * journal, chat and an exam registered as an empty square.
 *
 * Everything is derived from the stores that already own it, at read time.
 * Nothing is written down twice, which is what makes it impossible for a day
 * to disagree with the section it came from, and what makes every day that
 * happened before this file existed count anyway.
 *
 * Timestamps only. lib/activity.ts turns them into days, weeks and streaks and
 * knows nothing about any of these stores; this knows nothing about calendars.
 * ========================================================================== */
import * as store from "./store";
import * as chatStore from "./chatStore";
import * as journalStore from "./journalStore";
import * as examStore from "./examStore";
import * as memoryStore from "./memoryStore";
import * as figures from "./figures";
import { daysFrom, emptySource, type ActivitySource, type DayActivity } from "@/lib/activity";
import { allVersions } from "@/lib/visuals/keep";

/**
 * The project's days, ready to draw — and the function everything should call.
 *
 * Memoised against the version counter of every store it reads, which is
 * exactly the set of things that can change the answer. Without it this ran on
 * every render of the review rail, and the review rail re-renders on every
 * grade: a walk over every card in the project plus every conversation's
 * metadata, five to twenty milliseconds, in the loop somebody uses two hundred
 * times a day. The cache survives midnight safely because the map is keyed by
 * day and only `streaks()` and `today()` read the clock, at call time.
 */
export function daysFor(projectId: string): Map<string, DayActivity> {
  const key = [
    projectId,
    store.getVersion(),
    chatStore.getVersion(),
    journalStore.getVersion(),
    examStore.getVersion(),
    memoryStore.getVersion(),
    figures.getVersion()
  ].join(":");
  if (cached && cached.key === key) return cached.days;
  const days = daysFrom(sourceFor(projectId));
  cached = { key, days };
  return days;
}

let cached: { key: string; days: Map<string, DayActivity> } | null = null;

/**
 * Every timestamp this project has produced.
 *
 * A set of filtered walks over lists already in memory — no IndexedDB, no
 * awaits. Exported for tests and for anything that wants the raw shape;
 * daysFor() is what the UI calls.
 */
export function sourceFor(projectId: string): ActivitySource {
  const src = emptySource();
  const decks = store.decksOf(projectId);

  /* Reviews. db.log is one flat list across every project and is filed by
     deck id, which is why this is the one source that has to be filtered
     rather than asked. */
  for (const e of store.logOf(decks)) src.review.push(e.t);

  /* Cards written. `created` is stamped by normCard and preserved through
     edits on purpose, so this counts the day a card came into existence and
     not the last day somebody touched a typo in it. */
  for (const d of decks) {
    for (const c of d.cards) if (c.created) src.card.push(c.created);
  }

  for (const n of store.notesOf(projectId)) src.note.push(n.t);

  /* The journal. One entry per project per day, but a day's entry is built
     from appended chunks — so the chunks are what count, and a day you added
     to twice reads as two things done rather than one. */
  for (const e of journalStore.listForProject(projectId)) {
    if (e.raw.length) for (const r of e.raw) src.journal.push(r.at);
    else src.journal.push(e.created);
  }

  /* Conversations. The transcript is not in memory — chatStore keeps light
     metadata and loads a thread only when it is opened — so this counts the
     day a thread was started and the day it was last worked on, rather than
     every message. Accurate for today, which is what the readouts are mostly
     about, and it under-counts a day spent in the middle of an old thread.
     Counting messages properly would mean loading every transcript on every
     render of Home, which is not a trade worth making for one square. */
  for (const c of chatStore.list()) {
    if (c.projectId !== projectId || c.archived) continue;
    src.chat.push(c.created);
    if (dayApart(c.created, c.updated)) src.chat.push(c.updated);
  }

  /* Exams. Setting one and sitting it are two different days more often than
     not, and both were work. */
  for (const e of examStore.listForProject(projectId)) {
    src.exam.push(e.created);
    if (e.finishedAt && dayApart(e.created, e.finishedAt)) src.exam.push(e.finishedAt);
  }

  /* Memory, project-scoped. Global memories belong to no project and would
     light up every project's calendar with the same day. */
  for (const m of memoryStore.list({ scope: "project", projectId })) src.memory.push(m.created);

  /* Figures kept, and whiteboards drawn. Every version of a kept figure is a
     separate moment — `at` is when that source was put on the shelf — because
     coming back and keeping the revision is the same act as keeping it the
     first time. A board counts on the day it was made and not on every day it
     was saved: it saves itself on a timer while you draw. */
  for (const f of figures.list(projectId)) for (const v of allVersions(f)) src.figure.push(v.at);
  for (const b of figures.boards(projectId)) src.figure.push(b.created);

  return src;
}

/** True when two timestamps fall on different local days — so a thread
 *  started and finished in one sitting counts once, not twice. */
function dayApart(a: number, b: number): boolean {
  const da = new Date(a);
  const dbb = new Date(b);
  return (
    da.getFullYear() !== dbb.getFullYear() || da.getMonth() !== dbb.getMonth() || da.getDate() !== dbb.getDate()
  );
}
