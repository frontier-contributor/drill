/* ============================================================================
 * journal.ts — the daily log: raw capture, generated narrative, and the
 * weekly rollup that keeps it from growing without shape.
 *
 * See START-HERE.md §7 for the field-by-field rationale. The short version:
 * `raw` is never destroyed, `summary` is regenerable from it, and `distilled`
 * / `rolledUpIn` exist so running distill or rollup twice never repeats work.
 * ========================================================================== */

/** One chunk of raw input folded into a day's entry. Append-only — logging
 *  twice in a day adds a second RawLog, it never overwrites the first. */
export interface RawLog {
  id: string;
  at: number;
  /** "elsewhere" is a session in another AI brought in through the capture
   *  bridge (lib/capture.ts); its label is where it happened. */
  via: "typed" | "file" | "chat" | "elsewhere";
  /** filename, conversation title, the other AI's name, or "" for typed input */
  label: string;
  text: string;
}

export interface JournalSummary {
  /** 2-5 sentences, second person, the shape of the day. */
  narrative: string;
  did: string[];
  learned: string[];
  stuck: string[];
  open: string[];
  resources: { label: string; url: string }[];
  nextUp: string[];
  generatedBy: { model: string; at: number };
}

export interface JournalEntry {
  id: string;
  projectId: string;
  /** local day key, "2026-03-14" — one entry per project per day. */
  day: string;
  created: number;
  updated: number;

  raw: RawLog[];

  /** Null until generated. Regenerating rebuilds this from `raw`. */
  summary: JournalSummary | null;
  /** True once hand-edited, so regeneration warns before overwriting. */
  edited: boolean;

  distilled: {
    at: number | null;
    memoryIds: string[];
    cardIds: string[];
  };

  /** Which weekly rollup has already absorbed this entry. */
  rolledUpIn: string | null;
}

export interface PeriodRollup {
  id: string;
  projectId: string;
  from: number;
  to: number;
  /** "Week of 10 March" */
  label: string;
  entryIds: string[];
  narrative: string;
  themes: string[];
  stillOpen: string[];
  created: number;
}

/** A proposed change to project memory, produced by a rollup or a
 *  stand-alone consolidation pass. Nothing here is committed until the
 *  learner accepts each line in RollupDiff. */
export interface MemoryDiffAdd {
  kind: "add";
  type: import("./core").MemoryType;
  text: string;
}
export interface MemoryDiffMerge {
  kind: "merge";
  /** ids of the memories being folded together */
  from: string[];
  text: string;
}
export interface MemoryDiffRetire {
  kind: "retire";
  id: string;
  reason: string;
}
export type MemoryDiffLine = MemoryDiffAdd | MemoryDiffMerge | MemoryDiffRetire;
