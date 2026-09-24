/* ============================================================================
 * exam.ts — a generated, persisted, gradeable set of questions over a scope
 * of learning material. See START-HERE.md §4 Stage 5 for why this is not
 * just "the review loop again": `connect` and `derive` questions span more
 * than one card, which the drill loop structurally cannot produce.
 * ========================================================================== */
import type { Grade } from "@/types";

export type QuestionKind = "recall" | "apply" | "why" | "connect" | "derive" | "diagnose";
export type Difficulty = "recall" | "apply" | "analyse" | "synthesise";

export interface ExamScope {
  projectId: string;
  from: number | null;
  to: number | null;
  /** "last week" — shown before generating, so the scope is legible. */
  label: string;
  deckIds: string[];
  tags: string[];
  journalIds: string[];
  cardIds: string[];
  /** Free-text subject — "matplotlib", "gradient descent" — that narrowed
   *  material by relevance instead of by deck/tag. Kept on the scope so
   *  "more questions" replays the same target rather than losing it. */
  topic?: string;
  /** "weak": aimed at what the learner keeps getting wrong rather than at a
   *  subject or a period. The material is the cards those mistakes happened
   *  on, plus leeches and lapsed cards; `gaps` is the list itself. */
  focus?: "weak";
  /** The recurring confusions this exam targets, in the marker's words,
   *  frozen when it was built — so "more questions" aims at the same ones
   *  rather than at whatever the log says by then. */
  gaps?: string[];
}

export interface ExamSourceRef {
  kind: "card" | "journal" | "memory";
  id: string;
}

export interface ExamQuestion {
  id: string;
  kind: QuestionKind;
  difficulty: Difficulty;
  prompt: string;
  /** What a correct answer must contain — the marking key, hidden until graded. */
  expected: string;
  sourceRefs: ExamSourceRef[];

  answer: string | null;
  result: { grade: Grade; verdict: "got" | "partial" | "missed"; missing: string[]; note: string } | null;
  answeredAt: number | null;
}

export interface Exam {
  id: string;
  projectId: string;
  title: string;
  created: number;
  scope: ExamScope;
  /** Requested weighting, not a hard filter. */
  level: Difficulty;
  questions: ExamQuestion[];
  /** Set when the last question is graded; retaking clears it. */
  finishedAt: number | null;
  /** Rounds of "more questions", for the header. */
  rounds: number;
}
