/* ============================================================================
 * core.ts — projects, memory and notes: the entities v1 adds on top of the
 * original deck/card/srs model.
 *
 * A *project* is one thing you are learning. It owns decks, conversations,
 * notes and memory, and it is the scope every retrieval question is really
 * asking about: "what do I know about this learner, on this subject".
 *
 * The distinction that runs through this file:
 *
 *   a NOTE   is what the learner wrote        — a human artifact
 *   a MEMORY is what the system injects       — assembled into the prompt
 *
 * They are linked (a note can be promoted to a memory) but never merged, so
 * the insight log never fills up with machine-written summaries.
 * ========================================================================== */
import type { BackendType } from "@/types";
import type { Attachment } from "@/types/chat";

/** How much the app spends on one message: context depth, model, and (later)
 *  how many passes it is allowed. Per-message, inherited when unset. */
export type Effort = "low" | "medium" | "high";

/** How freely the app is allowed to write memory without being asked.
 *  "assisted" is the default: things the learner *stated* commit directly,
 *  things the model *inferred* wait in the tray. */
export type Autonomy = "manual" | "assisted" | "auto";

/* --------------------------------------------------------------- project -- */

/** A file or snippet that is attached to every conversation in a project.
 *  Content is inlined at add time — there is no server to re-fetch it from. */
export interface KnowledgeItem {
  id: string;
  name: string;
  kind: "file" | "text" | "link";
  /** The inlined content. For links, whatever the learner wrote about it. */
  text: string;
  /** bytes for files, characters otherwise — for the chip subtitle */
  size: number;
  addedAt: number;
  /** Off without deleting, so an expensive file can be parked. */
  enabled: boolean;
}

/** Defaults a project hands down to its conversations. Empty string / null
 *  means "inherit from global" — never "unset it". */
export interface ProjectDefaults {
  backend: BackendType | "";
  model: string;
  personaId: string;
  effort: Effort | "";
  temperature: number | null;
}

export interface MemoryPolicy {
  autonomy: Autonomy;
  /** Caps on how many memories may be injected per turn, before the token
   *  budget gets its own say. */
  maxGlobalInjected: number;
  maxProjectInjected: number;
}

export interface Project {
  id: string;
  name: string;
  /** One line, shown under the name in the switcher. */
  blurb: string;
  created: number;
  updated: number;
  archived: boolean;

  /** Injected verbatim as the project header on every turn, so keep it short.
   *  "Understand ML well enough to implement from scratch." */
  goals: string;

  deckIds: string[];

  defaults: ProjectDefaults;
  memoryPolicy: MemoryPolicy;
  knowledge: KnowledgeItem[];
}

/* ---------------------------------------------------------------- memory -- */

export type MemoryScope = "global" | "project";

/**
 * What kind of thing is being remembered. The type is not decoration: it sets
 * the retrieval weight, and `open` entries are deliberately resurfaced.
 */
export type MemoryType =
  /** global — who the learner is, how they think */
  | "profile"
  /** how they want to be taught */
  | "preference"
  /** project — what they are trying to achieve */
  | "goal"
  /** project — notation, sources, framing that has been agreed */
  | "convention"
  /** project — a concept that landed, in their own framing */
  | "understanding"
  /** project — raised and never resolved; worth bringing back up */
  | "open"
  /** a resource worth remembering */
  | "reference";

/** Where a memory came from. `stated` means the learner said it outright and
 *  the model only transcribed it — the one thing allowed to save itself. */
export type MemorySource = "stated" | "proposed" | "manual" | "consolidated" | "capture";

/** The turn a memory or candidate came out of, so the UI can show its origin. */
export interface MemoryOrigin {
  conversationId: string;
  turnId: string;
}

export interface Memory {
  id: string;
  scope: MemoryScope;
  /** null when scope is "global" */
  projectId: string | null;
  type: MemoryType;
  /** One fact, one entry. One to three sentences. */
  text: string;
  /** Lowercased, extracted at write time; the retrieval scorer's main input. */
  keywords: string[];

  /**
   * The subject this belongs under — "backprop", "optimisers", "notation".
   * Null for anything unfiled, which is most of what exists.
   *
   * Memory was a flat bag before this: you could ask it a question but you
   * could not *navigate* it, so "what do I know about X" had no answer that
   * did not run a keyword search and hope. A topic is one short slug, so it
   * costs nothing to store, groups the memory panel, gives retrieval a filter
   * that is exact rather than fuzzy, and gives the agent loop an index it can
   * walk. Deliberately free text rather than an enum: the subjects are the
   * learner's, and a fixed list would be wrong for the second project.
   */
  topic?: string | null;
  /** Ids of related memories. A cheap graph edge — enough for "these three
   *  are the same idea" without an ontology nobody maintains. */
  links?: string[];

  created: number;
  updatedAt: number;

  /* Retrieval telemetry — what makes decay and promotion possible. */
  useCount: number;
  lastUsed: number | null;

  /** Always injected, never decayed, never retired by consolidation. */
  pinned: boolean;
  /** False once superseded or retired. Nothing is ever hard-deleted by the
   *  app itself, so a bad consolidation stays recoverable. */
  active: boolean;
  supersededBy: string | null;

  source: MemorySource;
  origin: MemoryOrigin | null;
}

/** Not memory yet. Sits in the tray until the learner commits it. */
export interface MemoryCandidate {
  id: string;
  scope: MemoryScope;
  projectId: string | null;
  type: MemoryType;
  text: string;
  createdAt: number;
  origin: MemoryOrigin | null;
  /** Carried through to the Memory this becomes, so a topic proposed by the
   *  agent is not lost at the tray. */
  topic?: string | null;
  /** Id of the memory the model believes this replaces. */
  supersedes: string | null;
  /** True when the learner stated this outright rather than the model
   *  inferring it. Under "assisted" autonomy these commit without review —
   *  see services/candidates.propose. */
  stated?: boolean;
  status: "pending" | "accepted" | "rejected";
}

/* ----------------------------------------------------------------- notes -- */

export type NoteSource = "manual" | "chat" | "review" | "capture";

/**
 * The insight log. Still the learner's own words — `source` records how it
 * got here, and capture-sourced notes are always reviewed before landing.
 */
export interface Note {
  id: string;
  /** null only for notes written before projects existed and not yet placed. */
  projectId: string | null;
  t: number;
  text: string;
  tag: string;
  source: NoteSource;
  /** Set once promoted, so the note panel can link to its memory. */
  memoryId: string | null;
  /** Resources saved alongside the note — files brought back from elsewhere. */
  attachments: Attachment[];
}

/* ---------------------------------------------------------------- backup -- */

/** Everything, in one file: localStorage database plus every IndexedDB store.
 *  Ids are preserved on restore, otherwise projectId links would break. */
export interface FullBackup {
  kind: "drill-full-backup";
  /** Format version of the envelope, not of the database inside it. */
  version: 1;
  exportedAt: number;
  dbVersion: number;
  db: unknown;
  conversations: unknown[];
  memories: Memory[];
  candidates: MemoryCandidate[];
  journal: unknown[];
  rollups: unknown[];
  exams: unknown[];
  /** Absent in backups written before the usage ledger existed. */
  usage: unknown[];
  /** Attached pictures and PDFs, base64 — only when the backup was made with
   *  them included, and absent in every backup made before files existed. */
  files?: { id: string; name: string; mime: string; size: number; created: number; data: string }[];
}

/** What a backup contains, for the confirmation shown before restoring. */
export interface BackupSummary {
  exportedAt: number;
  dbVersion: number;
  /** Attached files carried in the backup. */
  files?: number;
  projects: number;
  decks: number;
  cards: number;
  notes: number;
  conversations: number;
  memories: number;
  candidates: number;
  journal: number;
  exams: number;
}
