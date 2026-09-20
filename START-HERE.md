# Drill — Build Plan

> **Point a fresh Claude Code session at this file to begin.**
>
> Opening move: *"Read START-HERE.md and build Phase N."*
>
> One phase per session. A phase is finished only when it works end to end —
> data, logic, UI, and a browser check. Never leave a phase half-wired.

---

## Progress

> **This table went stale once already.** It still read "Phase 1 — next" long
> after projects, journal, memory, distill and exams had all shipped, which
> made it worse than no table: a new session trusts it. Audited against the
> code on **2026-09-06**; if you finish a phase, tick it in the same commit.

### v1 — The Daily Loop

| Phase | | State |
|---|---|---|
| 0 | Foundations and safety | **done** |
| 1 | Projects | **done** |
| 2 | Log and Journal | **done** |
| 3 | Memory core | **done** |
| 4 | Distill — journal into memory and cards | **done** |
| 5 | Exams | **done** |
| 6 | Unified settings and the run transcript | **done** — genuinely, 2026-09-09 |

### v2 — Depth
| 7 | Chat on the journal | **done** |
| 8 | Files, attachments, `@` picker | **done** |
| 9 | Capture bridge from other AI apps | not started |
| 10 | Context inspector and cache tuning | **done** (inspector; cache tuning not started) |

### v3 — Later
| 11 | Auto-backup to disk | not started |
| 12 | Agent loop behind high effort | **done** — see §13 |
| 13 | Period reports, mind maps, richer media | **in progress** — files and attachments (pictures, PDF, Word, Excel, CSV, pinning, capture, knowledge, backup) done 2026-09-15; figures in replies (Mermaid diagrams, Vega-Lite charts, function plots with sliders, SVG) 2026-09-17; the live canvas — interactive pages in a no-network sandbox, versioned by the transcript — 2026-09-17; whiteboard (Excalidraw, self-hosted fonts, mermaid → editable shapes, board → chat as picture and text) and /map 2026-09-17; **the Figures section** — keeping a figure out of the thread that drew it, versioned, searchable, and the first place a whiteboard can be reopened from — 2026-09-20 |

**Phase 0 notes for whoever picks this up:**

- `DrillDB` is `v: 4`. `migrateToV4` in [src/lib/migrate.ts](src/lib/migrate.ts) is
  **idempotent** and runs on every load — it is both the upgrade and the repair
  pass. Add new v4 fields there; do not write a second migration.
- Pre-migration snapshot at `localStorage["mldrill:v3:backup"]`, **write-once**.
  Verified: a later bad state cannot overwrite it.
- `store.initReport()` returns `{fresh, fromVersion, migrated, backedUp}`.
  Nothing surfaces it yet — Phase 6 should.
- IndexedDB `drill-chat` was left at v2 by Phase 0, with `memories` and
  `candidates` created but unread. It is **v4** now and both are load-bearing;
  the guarded `contains()` pattern in `idb.ts` is how stores were added since.
- Conversations gain new fields lazily via `chatStore.repair()`. No bulk migration.
- New records use `U.uuid()`. `U.uid()` stays for cards and decks, whose ids
  appear in deck files and must survive re-import.
- `vite.config.ts` honours `PORT`; `.claude/launch.json` uses `autoPort`.

---

## 1. What this is

**Drill is a learning journal that turns what you did today into things you
will still know in six months.**

The loop, once a day, in about two minutes of your attention:

```
   you type what you did today
        │
        ▼
   ┌──────────┐   a narrative entry, not a text dump:
   │ JOURNAL  │   what you did, what landed, where you got stuck,
   └──────────┘   what is still open
        │
        ▼
   ┌──────────┐   memory candidates + card proposals,
   │ DISTILL  │   each one reviewed, nothing auto-committed
   └──────────┘
        │
        ├──────────────► cards enter FSRS and come back on schedule
        │
        └──────────────► memory shapes every later answer
                              │
                              ▼
                        ┌──────────┐   "test me on last week"
                        │  EXAMINE │   graded, extendable, harder on request
                        └──────────┘
```

Everything else in the app — chat, decks, the review loop — hangs off that
spine.

### Why this beats a chat window that remembers

The old framing was *chat that accumulates memory*. The problem: memory only
accrues if you happen to chat, and what accrues is a byproduct of conversation
rather than a record of learning.

Journaling fixes both. It gives memory a **trigger** (end of day), a **shape**
(what did I do, what landed, what is open), and a **rhythm** (daily entries
roll up weekly, weekly rolls into project memory). The junk-drawer failure
mode that kills most memory systems is solved structurally rather than by a
button nobody presses.

### The single-sentence test for any feature below

*Does it help the learner get from "I studied today" to "I still know it in
six months"?* If not, it is v3 or it is cut.

---

## 2. Locked decisions

Do not relitigate these while building.

1. **Frontend only.** No backend, no accounts, no sync. Browser storage plus
   the user's own API key.
2. **Pipeline by default; agent loop where it is asked for.** *Amended
   2026-09-06, when Phase 12 landed — this decision was written expecting to be
   cashed in, and it was.* Every non-chat operation (journal, distill, rollup,
   exam, card writing, marking) is still exactly one API call with
   deterministic TypeScript retrieval, and that is not negotiable. Chat now has
   three modes, per conversation: `direct` is the old single call and remains
   the default; `agent` and `deep` run the loop in `services/agent/`. As
   predicted, the effort dial is where it landed — `agentSteps` on
   `EffortBudget`. See §13.
3. **No embeddings.** Keyword + recency + usage scoring, plus date filtering,
   which is exact and free.
4. **Nothing commits itself.** Every stage proposes; the learner accepts.
   The one exception is transcribing a fact the learner explicitly stated, and
   that has an off switch.
5. **Raw input is never destroyed.** Every generated artifact — journal
   narrative, memory, card, exam question — records what it came from and can
   be regenerated. A bad summarisation costs one call, never your data.
6. **Never memorise what can be computed.** Card stats, lapses, due counts and
   weak areas are queried live. Memory holds how you think, not what you scored.
7. **Project is the top-level entity.** It owns decks, journals, conversations,
   memory, and exams.
8. **Cards are atomic and self-contained.** A card that only makes sense in the
   context of the day it was written is a broken card. Enforced by a quality
   gate, not by hope.

---

## 3. What already exists

### Storage

| World | Where | Holds | Access |
|---|---|---|---|
| `DrillDB` v4 | `localStorage["mldrill:v3"]` | settings, **projects**, decks, srs, log, notes | **sync**, `services/store.ts` |
| Chat + memory | IndexedDB `drill-chat` **v4** | conversations, meta, memories, candidates, journal, rollups, exams, usage | **async**, `services/chatStore.ts`, `idb.ts` |
| Files + work | IndexedDB `drill-files` **v3** | attachment originals, whiteboards, kept figures | **async**, `services/files/db.ts`, `services/figures.ts` |

The sync/async split is load-bearing: the review loop renders without awaiting
IndexedDB. New small data goes in `DrillDB`; new growing data goes in
IndexedDB behind a sync cache, copying the `chatStore` pattern.

### Seams worth knowing

- **`services/ai/index.ts` → `chat()`** — the single inference boundary.
  Already provides `generateCards`, `splitCard`, **`markRecall`**,
  `generateTitle`, `suggestFollowups`, `resolve`, `listModels`, `formatReply`.
- **`markRecall(card, attempt)` → `{grade, verdict, missing, note}`** — exam
  grading is this function in a loop. Do not write a second grader.
- **`ProposalsBlock`** — `{label, cards, targetDeck, onCommitted}`. Every
  card-proposing surface uses it. Distilled cards use it too.
- **`lib/chatContext.ts`** — `renderSource` / `describeSource` / `sourceSize` /
  `buildContext`. Context is rebuilt at send time, never frozen. Every source in
  the type is now implemented: `deck`, `weak`, `due`, `notes`, `memory`,
  `knowledge`, `journal`, and `today` (which is `lib/dayBrief.ts` — the only
  source that is a *moment* rather than a category, and the one that puts the
  review log and the learner's own recall attempts into a prompt).
- **`store.isLeech`**, `weakCards`, `dueCards` — the drill-data queries exist.
- **`types/core.ts`** — `Project`, `Memory`, `MemoryCandidate`, `Note`, `Effort`,
  `KnowledgeItem`, `FullBackup` all defined in Phase 0.
- **`services/backup.ts`** — full export/restore across all three storage
  worlds, ids preserved. Extend it whenever a new store appears — the `figures`
  store of `drill-files` was the most recent one to need it. Its UI is
  **Settings → Data**, reachable from every section; it used to be behind the
  review loop's Menu, where five of the six sections could not get to it.
- **`context/SettingsContext.tsx` + `components/settings/registry.tsx`** — one
  settings panel for the whole app, mounted once by `Shell`, with its category
  list declared in one record. Anything settings-shaped goes in the registry,
  not into a section's own menu.

### Known problems still open

*Both original entries here were fixed by Phases 3 and 6 and are removed;
what follows is the list as it actually stands on 2026-09-06.*

- **No error boundary at the root.** A render crash in `Shell`, `Sidebar` or the
  composer takes down the whole app, not one view. This was hit for real during
  Phase 12 (a component rendered before its new prop was threaded through) and
  the whole tree went with it. `components/ui/ErrorGuard.tsx` now contains it
  locally — the sheet router and the settings body use it — but nothing wraps
  the tree above them.
- **The agent loop has never run against a real model.** No API key in this
  environment. See §13, "What is verified, and what is not".
- **Drafts reset on navigation.** `draftModel`, `draftEffort`, `draftMode` and
  `draftActions` live in `ChatContext` state; leaving chat and coming back
  loses an unsent choice. Long-standing, minor, one fix for all four.
- **Phase 9 (capture bridge) and Phase 11 (auto-backup to disk) are not
  started**, and cache tuning from Phase 10 is not either. Phase 11 is now the
  most valuable of the three: see below.
- **The review log lives in localStorage, and that is the wrong drawer.**
  Decks, scheduling and the whole review log share one ~5MB origin quota,
  because `store.ts` is synchronous and everything reads `db.log` without
  awaiting. A year of daily review is fifteen to twenty thousand entries, and
  every recall attempt carried up to 260 characters of text — so heavy users
  reached the wall, and until 2026-09-09 the save path swallowed the failure
  and the app carried on looking healthy while nothing was written.

  That is fixed the honest way for now: writes report, `saveNow()` sheds and
  retries, `lib/logBudget.ts` owns what may be given up, and `SaveAlarm` says
  so across every section. The *real* fix is to move `log` into IndexedDB,
  where the chat, journal, memory and exam stores already live and the quota
  is two orders of magnitude larger. That is a migration with real risk on a
  database people already have years in, so it wants doing deliberately and
  not as a side effect of something else.
- **The review tutor is still a second chat client.** `panes/ChatPane.tsx`
  holds its exchange in a ref and calls `AI.chat` directly — it is not a
  `Conversation`, so it cannot be reopened, searched, branched or regenerated,
  and it has no streaming buffer, no abort, no usage accounting and no agent
  modes. "Continue in Chat" now writes it out as a real conversation rather
  than letting it evaporate, which was the part that actually lost work, but
  the duplication is still there. The right end state is one chat surface,
  mounted in the sheet with the card as its context.
- **Exam scope cannot target a gap.** `generateExam` is given the gap list in
  its system prompt, so it weights toward them, but `lib/examScope.ts` still
  selects material by time and deck alone. "Examine me on what I keep getting
  wrong" is a scope, and it is the one somebody would actually pick.
- **Two tabs still overwrite each other.** Detected and warned about, not
  merged. A real fix needs either a lock (Web Locks API, no Safari before 15.4)
  or per-record writes, which is the same IndexedDB move as above.

---

## 4. The five stages

### Stage 1 — Capture

One box. The lowest-friction thing in the app.

- Free text: what you did, what you read, what confused you, links, anything.
- Paste or drop a `.md` / `.txt` file — read with `FileReader`, appended to the
  same day's raw log with a source marker.
- **Append, don't replace.** Logging twice in a day adds to that day's entry.
- Capture never calls the API. It saves instantly and works offline.

That last rule matters more than it looks: if capture can fail or stall, you
stop using it, and the whole system dies at the root.

### Stage 2 — Journal

One call turns the day's raw text into a **narrative entry**.

Not a bulleted summary — a short piece of writing in second person that reads
like a log of a day's work, plus structured fields alongside it:

| Field | What it holds |
|---|---|
| `narrative` | 2–5 sentences. The journey: what you set out to do, what actually happened. |
| `did` | concrete actions completed |
| `learned` | what landed conceptually, in your framing |
| `stuck` | where you struggled, and what the specific confusion was |
| `open` | questions raised and not resolved |
| `resources` | books, links, videos, papers mentioned |
| `nextUp` | the obvious next step |

`stuck` and `open` are the two fields that earn their keep. `stuck` is where
cards should come from — the things you nearly know are worth drilling, the
things you found trivial are not. `open` is what gets resurfaced weeks later
when nothing else would have brought it back.

The narrative is **regenerable**: the raw text is kept forever, so a bad entry
is one click to redo. Editable by hand, and an edited entry is marked so a
regeneration warns before overwriting it.

### Stage 3 — Distill

One call, run when you ask for it, turning a journal entry into two reviewable
piles.

**Memory candidates** — into the tray, exactly as designed before:
- `understanding` from `learned`
- `open` from `open`
- `convention` / `goal` when the entry states one
- `preference` only from things you said about yourself

**Card proposals** — into `ProposalsBlock`, weighted toward `stuck` and
`learned`.

#### The card quality gate

This is the part that decides whether the feature is good or merely present.
Cards written with today's context fresh in your head are systematically
under-specified — you write *"What was the trick with the gradient?"* because
right now it is obvious what trick you mean. In six weeks it is unanswerable.

Every proposed card is checked, in the same call, against four rules:

1. **Atomic** — one fact, one question. If the answer has an "and" joining two
   ideas, it is two cards.
2. **Self-contained** — answerable with no memory of the day it came from. No
   "the trick", "the paper", "as we discussed".
3. **Recall, not recognition** — the front must demand production, not a yes/no
   or a pick-from-list.
4. **Non-duplicate** — checked against existing cards in the project's decks by
   keyword overlap, locally, before the call even goes out.

Cards failing 1–3 are rewritten by the model rather than dropped. Cards failing
4 are shown greyed with the card they collide with, so you can pick.

Nothing is written until you accept it. Distilling twice on the same entry is
safe: already-committed items are recognised and shown as such.

### Stage 4 — Review

Unchanged — this is the existing FSRS loop, and it already works. The only new
wiring:

- Cards remember which journal entry they came from (`sourceRef`), so the
  review screen can show *"from your log on 12 March"* and jump to it.
- A card you keep failing can be traced back to the day you learned it, which
  is often the actual explanation.

### Stage 5 — Examine

The feature that turns a pile of cards into a sense of whether you actually
know the material.

**What an exam is:** a generated, persisted set of questions with a scope, a
difficulty, and a grade report. Retakeable. Extendable.

**Scope** — any combination, resolved locally before any call:
- a date range — *"what I learned three days ago"*, *"last week"*, *"this month"*
- a project, a deck, or a set of tags
- a specific journal entry
- specific cards

**Why an exam is not just a quiz over cards.** If it only re-asks cards
one by one, it is a worse version of the review loop and should not exist. Its
distinct job is **questions that span material**:

| Kind | What it asks | Source |
|---|---|---|
| `recall` | one fact, short answer | a single card |
| `apply` | use it on a new case | a card + its context |
| `why` | justify, explain the mechanism | `learned` / `understanding` |
| `connect` | relate two things learned separately | two or more cards |
| `derive` | work it out from principles | a convention + a card |
| `diagnose` | find the error in a worked example | a `stuck` entry |

`connect` and `derive` are the ones the drill loop structurally cannot produce,
and they are where the difficulty ladder lives.

**Difficulty** — four rungs, and "make it harder" moves up:
`recall → apply → analyse → synthesise`. An exam is a mix, weighted by the
requested level, not a uniform block.

**Grounding.** Every question stores `sourceRefs` — the cards, journal entries
or memories it was built from. This is not bookkeeping: it is how you check a
suspicious question against what you actually wrote, and it is how "more
questions on this" knows what "this" means.

**Taking it.** One question at a time, free response. Grading reuses
`AI.markRecall` — one call per answer, the same strictness as the review loop,
returning `{grade, verdict, missing, note}`.

**The report** — per question: your answer, the verdict, what you missed.
Overall: a score, the weakest topics, and three actions:
- **wrong answer → new card** (through `ProposalsBlock`)
- **wrong answer → reset that card's FSRS state**, because a card you passed in
  drilling but failed in an exam was a false positive
- **weak topic → more questions**

**Extending.** "More questions" and "harder" re-run generation with the same
scope, excluding questions already asked, appending to the same exam.

---

## 5. Time scoping

*"Test me on what I learned three days ago"* has to work without an API call to
figure out what "three days ago" means.

A small local parser in `lib/when.ts` handles the phrases people actually use:

```
today · yesterday · this week · last week · this month
last N days/weeks · N days ago · since <date> · <month> · <date>..<date>
```

Returns `{from, to, label}` or null. Anything it cannot parse falls through to
a date-range picker rather than guessing. Deterministic, testable, free, and it
makes the exam scope legible before you spend a call on it — you see
*"14–20 March · 4 journal entries · 23 cards"* before generating.

---

## 6. Rhythm — how memory stays clean

The junk-drawer problem — cheap models over-save until retrieval degrades —
is solved by giving consolidation a natural cadence instead of a button:

```
  daily     capture → journal              (raw kept forever)
     ↓
  weekly    rollup: 7 entries → one period summary
            + memory candidates promoted to project memory
            + duplicates merged, contradictions resolved via supersededBy
            + stale `open` items either resurfaced or retired
     ↓
  project   a small, sharp set of what is actually true about this subject
```

A rollup is one call and produces a **diff you approve** — `+3 new · ~2 merged
· −1 retired`, full text shown, each line editable and individually
rejectable. Retired entries set `active: false`; nothing is ever hard-deleted.

Global memory is capped at ~25 active entries and consolidated aggressively.
Project memory can be generous. Journals are never consolidated away — they are
the raw record.

Weekly is a default, not a rule: the rollup is available any time, and knows
what it already covered.

---

## 7. Data model

New types go in `src/types/journal.ts` and `src/types/exam.ts`, re-exported
from `@/types` like `core.ts` is.

```ts
/* ------------------------------------------------------------- journal -- */

export interface RawLog {
  id: string;
  at: number;
  /** "typed" | "file" | "chat" — where this chunk came from */
  via: "typed" | "file" | "chat";
  /** filename, conversation title, or "" */
  label: string;
  text: string;
}

export interface JournalEntry {
  id: string;
  projectId: string;
  /** local day key, "2026-03-14". One entry per project per day. */
  day: string;
  created: number;
  updated: number;

  /** Everything you fed it, in order, never destroyed. */
  raw: RawLog[];

  /** Null until generated. Regenerating rebuilds this from `raw`. */
  summary: JournalSummary | null;
  /** True once hand-edited, so regeneration warns first. */
  edited: boolean;

  /** What has already been pulled out of this entry, so distilling twice
   *  does not propose the same things again. */
  distilled: {
    at: number | null;
    memoryIds: string[];
    cardIds: string[];
  };

  /** Which weekly rollup has already absorbed this entry. */
  rolledUpIn: string | null;
}

export interface JournalSummary {
  narrative: string;
  did: string[];
  learned: string[];
  stuck: string[];
  open: string[];
  resources: { label: string; url: string }[];
  nextUp: string[];
  /** model + when, so a thin entry can be blamed on the right thing */
  generatedBy: { model: string; at: number };
}

export interface PeriodRollup {
  id: string;
  projectId: string;
  from: number;
  to: number;
  label: string;              // "Week of 10 March"
  entryIds: string[];
  narrative: string;
  themes: string[];
  stillOpen: string[];
  created: number;
}

/* ---------------------------------------------------------------- exam -- */

export type QuestionKind = "recall" | "apply" | "why" | "connect" | "derive" | "diagnose";
export type Difficulty = "recall" | "apply" | "analyse" | "synthesise";

export interface ExamScope {
  projectId: string;
  from: number | null;
  to: number | null;
  label: string;              // "last week", shown before generating
  deckIds: string[];
  tags: string[];
  journalIds: string[];
  cardIds: string[];
}

export interface ExamQuestion {
  id: string;
  kind: QuestionKind;
  difficulty: Difficulty;
  prompt: string;
  /** What a correct answer must contain. Used for grading, hidden until then. */
  expected: string;
  /** Everything this was built from — the anti-hallucination trace. */
  sourceRefs: { kind: "card" | "journal" | "memory"; id: string }[];

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
```

### Changes to existing types

```ts
// Card gains provenance — where it came from, so a failing card can be
// traced back to the day it was learned.
export interface Card {
  // …existing…
  sourceRef?: { kind: "journal" | "exam" | "chat" | "note" | "manual"; id: string };
}

// ContextSource gains the journal, live like everything else.
export type ContextSource =
  // …existing…
  | { kind: "journal"; days: number };
```

### Storage placement

| Data | Store | Why |
|---|---|---|
| `JournalEntry` | IndexedDB, new store `journal` | grows daily, holds raw text forever |
| `PeriodRollup` | IndexedDB, new store `rollups` | small but lives with journals |
| `Exam` | IndexedDB, new store `exams` | grows, and never needed synchronously |
| `Memory`, `MemoryCandidate` | IndexedDB (exists) | |
| `Project`, `Note`, decks, srs | `DrillDB` (exists) | needed synchronously by the review loop |

IndexedDB goes to **v3** with `journal`, `rollups`, `exams`. Same guarded
`onupgradeneeded` pattern as Phase 0 — add `contains()` blocks, do not switch
on `oldVersion`. Extend `services/backup.ts` in the same phase that adds a
store, every time.

---

## 8. Cost

A full day of use, on a cheap model:

| Operation | Calls | When |
|---|---|---|
| Capture | **0** | always instant, works offline |
| Journal | 1 | once a day, when asked |
| Distill | 1 | once a day, when asked |
| Weekly rollup | 1 | once a week |
| Exam generation | 1 | when asked |
| Exam grading | 1 per answer | while taking it |
| Chat | 1 per message | as before |

A normal day is **two calls**. A week with one 10-question exam is about
**twenty-five**. On DeepSeek-class pricing that is cents per month.

Grading is the only per-item cost. It is worth it — `markRecall` already
carries the review loop and the strictness is the point — but batching all
answers into one grading call is the obvious v2 optimisation if it bites.

**Prompt cache discipline** applies to every call: stable ordering, no
timestamps in the cached prefix, volatile content last.

---

## 9. Versions and phases

**A phase is one working session and ends with the app fully working.**
Vertical slices — data, logic, UI, and a browser check — never a layer.

---

### v1 — The Daily Loop

The complete workflow. Standalone value: log, journal, distil, drill, examine.

---

#### Phase 1 — Projects

Everything scopes to a project, so this comes first.

- `src/services/projects.ts` — CRUD, active project, archive, deck assignment.
  Re-export `makeProject` from `lib/migrate.ts`.
- `src/context/ProjectContext.tsx`
- `ProjectSwitcher` in the header
- Routes become `#/p/<id>/drill` and `#/p/<id>/chat/<cid>`; old hashes redirect
  for one version
- Decks pane and chat sidebar filter to the active project
- Project settings: name, blurb, goals, decks in/out

**Done when:** two projects with different decks and conversations coexist with
no leakage, and switching projects changes what the review loop serves.

---

#### Phase 2 — Log and Journal

The heart of the product. After this phase the app is already useful.

- IndexedDB **v3** with the `journal` store; extend `backup.ts` in this phase
- `src/services/journalStore.ts` — sync cache + debounced persist, modelled on
  `chatStore.ts`
- `src/lib/when.ts` — the date-phrase parser, with unit-style checks
- **Capture box**: free text, append-to-today, `.md`/`.txt` drop and paste.
  Zero API calls, saves instantly
- `AI.writeJournal(raw, project)` → `JournalSummary`
- **Journal view**: today's entry with narrative and the seven fields; edit any
  field; regenerate with an are-you-sure when `edited`
- **Timeline**: entries by day, filterable by the `when.ts` parser

**Done when:** you can paste a paragraph about your day, get a narrative entry
with `stuck` and `open` populated, edit it, regenerate it, and find it again by
typing "last week".

---

#### Phase 3 — Memory core

- `src/services/memoryStore.ts` — IndexedDB-backed, sync read cache, debounced
  persist
- `src/services/candidates.ts` — the staging tray
- `src/lib/memoryRetrieval.ts` — scoring, token budget, `RetrievalTrace`,
  usage telemetry on inject
- `{ kind: "memory" }`, `{ kind: "knowledge" }`, `{ kind: "journal" }` branches
  in `lib/chatContext.ts`
- **Memory panel**: browse, filter by scope/type/source, edit, pin, retire
- **Candidate tray**: badge, accept/edit/reject, bulk actions

Scoring, as specified before:

```
score = 3.0 * keywordOverlap
      + 1.5 * typeWeight          (open, goal, convention rank high)
      + 1.0 * recencyDecay        (~60 day half-life)
      + 0.5 * usageBoost          (log1p, capped)
      + 10.0 * pinned
```

**Done when:** a hand-written memory is retrieved, visibly changes a chat
answer, and the panel shows why it was picked.

---

#### Phase 4 — Distill

Joins Phases 2 and 3 into the actual loop.

- `AI.distill(entry, project, existingCards)` → memory candidates + card
  proposals in one structured reply
- **The card quality gate** — atomic / self-contained / recall / non-duplicate,
  with local duplicate detection before the call
- Review surface: two piles, memory into the tray, cards into `ProposalsBlock`
- `entry.distilled` bookkeeping so a second run does not re-propose
- `Card.sourceRef` set on commit; the review screen shows *"from your log on…"*
- **Weekly rollup** with diff review, `rolledUpIn` bookkeeping
- Memory **consolidation** with the same diff component

**Done when:** one click on a journal entry yields reviewable memories and
cards, committing them files the cards in the right deck with provenance, and
running it again proposes only what is new.

---

#### Phase 5 — Exams

- IndexedDB **v4** with the `exams` store; extend `backup.ts`
- `src/services/examStore.ts`
- **Scope builder** — date phrase or picker, deck/tag filters, showing
  *"14–20 March · 4 entries · 23 cards"* before you spend a call
- `AI.generateExam(scope, level, exclude)` → questions with `sourceRefs`
- **Take view** — one question at a time, free response, grading via
  `AI.markRecall`
- **Report** — score, weakest topics, per-question verdict and misses
- Three follow-through actions: wrong answer → card, wrong answer → reset that
  card's FSRS state, weak topic → more questions
- **Extend**: "more" and "harder", appending to the same exam without repeats

**Done when:** "test me on last week" produces a grounded mixed-difficulty exam,
grades free-text answers, and a wrong answer can become a card or reset the
card it came from.

---

#### Phase 6 — Unified settings and the run transcript

- Settings kit in `components/ui/`: `SettingRow`, `SelectRow`, `NumberRow`,
  `SecretRow`, `ModelPicker`
- `src/lib/resolveSetting.ts` — value **plus provenance**
- One `SettingsPanel`, three scopes, every row showing where its value came
  from: `Model: deepseek-chat (from Project)`
- **Delete** `panes/SettingsPane.tsx` and `chat/SettingsDrawer.tsx`; fix the
  in-place mutation and `setTick` pattern
- Surface `store.initReport()` and storage health
- **Run transcript**: for every AI operation — journal, distil, exam, chat —
  what was sent, what came back, tokens, cost, elapsed. The debugging tool for
  everything above and the honest answer to "what is it doing".

**Done when:** every setting lives in one place and states its origin, and any
operation can be opened up to see exactly what it sent.

**Finished 2026-09-09**, one phase late. Phase 6 shipped the panel and left
four things outside it, all in the review loop's Menu — a sheet only the
review loop mounts, so they existed from one of the six sections: backup and
restore (moved in the settings rework), and then the memory browser, the memory
tray and the run transcript. Deck management was a set of `window.prompt()`
calls in the same place; "Mix all decks" was a switch you could only reach
while reviewing; `settings.sessionSize` had no control at all.

They are pages now — Memory of its own, decks under the project, the queue and
the day's run under Review, the transcript under Usage — the rail is grouped
and holds still while the page scrolls, and search returns the *group of
settings* rather than the page it is on and scrolls to it. `settings/
catalogue.ts` is the single declaration of all of it, pure data, held to its
promises by `catalogue.test.ts`. What is left in the review Menu is statistics,
the insight log, and signposts.

---

### v2 — Depth

**Phase 7 — Chat on the journal.** Journal as a `ContextSource`; "discuss this
entry"; effort dial per message routing model and context depth; memory
directives extracted from replies into the tray.

**Phase 8 — Files, attachments, `@` picker.** `@` mentions for cards, decks,
journals, memories, files; drag-drop and paste; project knowledge always
attached; message-scoped vs pinned; context budget bar.

**Phase 9 — Capture bridge.** A project-aware prompt to paste into another AI,
and a parser for what it returns — notes, memory candidates, card proposals,
open threads — in one reviewed commit. The learning you did elsewhere stops
dying there.

**Phase 10 — Context inspector and cache tuning.** Per-section token counts,
every memory considered with its component scores, prefix stability checks.

---

### v3 — Later

**Phase 11 — Auto-backup to disk.** File System Access API, folder picked once,
debounced snapshots, feature-detected.

**Phase 12 — Agent loop behind high effort.** Only here, and only behind the
dial. Low and medium stay one call forever.

**Phase 13 — Period reports, mind maps, richer media.** Monthly and course-long
reports; concept maps from memory and cards; images and PDFs in capture.

---

## 10. File map for v1

**New**

```
src/types/journal.ts                    RawLog, JournalEntry, JournalSummary, PeriodRollup
src/types/exam.ts                       Exam, ExamQuestion, ExamScope, Difficulty
src/services/projects.ts                project CRUD
src/services/journalStore.ts            journal + rollups, IndexedDB + sync cache
src/services/memoryStore.ts             memory, IndexedDB + sync cache
src/services/candidates.ts              the staging tray
src/services/examStore.ts               exams
src/lib/when.ts                         date-phrase parser
src/lib/memoryRetrieval.ts              scoring, budget, trace
src/lib/cardGate.ts                     atomicity / self-containment / duplicate checks
src/lib/resolveSetting.ts               inheritance with provenance
src/context/ProjectContext.tsx
src/context/JournalContext.tsx
src/components/ProjectSwitcher.tsx
src/components/journal/CaptureBox.tsx
src/components/journal/JournalEntryView.tsx
src/components/journal/Timeline.tsx
src/components/journal/DistillReview.tsx
src/components/journal/RollupDiff.tsx       shared with memory consolidation
src/components/memory/MemoryPanel.tsx
src/components/memory/CandidateTray.tsx
src/components/exam/ScopeBuilder.tsx
src/components/exam/TakeExam.tsx
src/components/exam/ExamReport.tsx
src/components/settings/SettingsPanel.tsx
src/components/settings/{Global,Project,Conversation}Scope.tsx
src/components/ui/{SettingRow,SelectRow,NumberRow,SecretRow,ModelPicker}.tsx
src/components/RunTranscript.tsx
```

**Changed**

```
src/types.ts                Card.sourceRef; re-export journal + exam types
src/types/chat.ts           ContextSource += journal
src/services/idb.ts         v3 journal + rollups, v4 exams
src/services/backup.ts      new stores, every time one is added
src/services/store.ts       card provenance on commit
src/services/ai/index.ts    writeJournal, distill, generateExam, rollup, consolidate
src/lib/chatContext.ts      memory, knowledge and journal sources
src/context/RouteContext.tsx  project-scoped routes, journal and exam views
src/App.tsx                 ProjectProvider, JournalProvider
```

**Deleted in Phase 6**

```
src/components/panes/SettingsPane.tsx
src/components/chat/SettingsDrawer.tsx
```

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| **Journaling becomes a chore and stops** | Capture is zero-friction and zero-cost; journal generation is optional and deferred. A day with raw text and no summary is a valid day. |
| **Cheap models write vague cards** | The quality gate rewrites rather than drops; local duplicate detection runs before the call; nothing commits unreviewed. |
| **Exams reduce to a worse review loop** | `connect` and `derive` questions are the point. If a generated exam is all `recall`, the prompt is wrong — fix it there, not by adding features. |
| **Hallucinated exam questions** | `sourceRefs` on every question, always shown. A question with no source is a bug. |
| **Memory junk drawer** | Weekly rollup with diff review; hard cap on global; `supersededBy` instead of append-only. |
| **IndexedDB eviction** | `persist()` already requested in Phase 0; full backup exists; disk auto-backup in v3. |
| **Scope creep into an agent loop** | Phase 12, behind the effort dial. Nothing before it gets a second call. |
| **Bundle growth in the review loop** | Journal, exam and memory UI lazy-loaded like `ChatView` already is. |

---

## 12. Appendix — prompt sketches

Wording will need tuning; the structure should not.

**Journal**

> Below is what the learner did today, in their own words, possibly messy and
> out of order. Write their log entry.
>
> `narrative` is 2–5 sentences in second person — the shape of the day, not a
> list. Be concrete and do not flatter. If the day was thin, say so briefly
> rather than inflating it.
>
> `stuck` is the most important field: capture the *specific* confusion, not
> the topic. "Could not see why the chain rule gives that ordering" beats
> "struggled with backprop". If they were not stuck on anything, leave it
> empty rather than inventing difficulty.
>
> `open` is anything raised and not resolved — a question they asked and
> dropped, a thing they said they would look up. Leave empty rather than
> padding.
>
> Use only what is in the text. Do not add facts, do not correct their
> understanding, do not teach. Reply as one fenced `drill-journal` JSON block.

**Distill**

> From this journal entry, produce two things.
>
> Memories: only what is durable. Prefer few and sharp. Never record what can
> be computed from review history — which cards are failing, how many are due,
> streaks. Record how they think, what framing works, what they have settled
> on, and what they left unresolved.
>
> Cards: weighted toward `stuck` and `learned`. Every card must be atomic (one
> fact), self-contained (answerable in six months with no memory of today — no
> "the trick", "the paper", "as discussed"), and demand recall rather than
> recognition. If a draft card fails any of these, rewrite it before returning
> it. The existing cards listed above are already covered; do not duplicate
> them.

**Exam generation**

> Build an exam from the material below, weighted toward the `{level}` rung.
>
> Do not simply restate flashcards. At least half the questions must span two
> or more sources — connect ideas learned separately, apply something to a new
> case, derive a result from a stated convention, or diagnose an error.
>
> Every question carries `sourceRefs` naming exactly what it was built from.
> If you cannot ground a question in the material, do not write it. Fewer,
> well-founded questions beat a full set with invented ones.
>
> `expected` states what a correct answer must contain — the marking key, not
> a model answer.

**Weekly rollup**

> These are the learner's daily entries for this period. Write the period
> summary: the themes that actually recurred, what changed in their
> understanding, and what is still open. Then propose updates to project
> memory — new entries, merges of things now known to be the same, and
> retirements of anything these entries have superseded. Mark each retirement
> with the id it replaces. Invent nothing not present in the entries.

---

## 13. Phase 12 — the agent loop

Landed 2026-09-05/06. `src/services/agent/` plus `src/types/agent.ts`, about
2,300 lines including tests. Written twice: once from first principles, then
rebuilt the same day against published agent-design research, which found three
real faults in the first version. The rebuild is what shipped.

### Three chat modes

`Conversation.mode`, per conversation, resolved in `ChatContext.run()`:

| mode | what it does | rounds |
|---|---|---|
| `direct` | one request, context chosen up front by `lib/chatContext.ts` | 0 |
| `agent` | looks things up reactively, then answers | `agentSteps` (1/3/6) |
| `deep` | states a plan, works every step, closes it out, then answers | `deepSteps()` = 2n+2 |

`direct` is the default and must stay the default — it is right for most
messages, and the other two cost a request per round. An older two-value flag
spelled the first mode `"chat"`; `chatStore.repair()` renames it and lands
anything unrecognised on `direct`, so no existing thread silently became
multi-request.

### The shape, and why

- **`loop.ts` takes `chat` *and* `runTool` injected.** This is not decoration.
  There is no API key here and `tools.ts` reaches localStorage and IndexedDB,
  so injection is the only reason the control flow — budgets, stopping, aborts,
  the plan close-out — has 28 tests that run under `node --test`. Keep it
  injected. The loop owns `ToolContext.scratch`; callers pass
  `Omit<ToolContext, "scratch">`.
- **Two wire protocols, one catalogue** (`protocol.ts`). `native` is the
  provider's own `tools`/`tool_calls`; `text` is a fenced ```drill-call block,
  which is what lets the whole loop run on Ollama and llama.cpp. Both flatten
  to `ToolCall[]` before `loop.ts` sees anything, so the loop never branches on
  protocol.
- **Writes still propose.** §2.4 survives: every write tool goes through
  `services/candidates` and the project's autonomy policy. A `manual` project
  gets a read-only assistant, and the catalogue is *filtered* rather than the
  model being asked nicely — "please do not write" is not a permission model.
- **Eleven tools, named as verbs** — `recall`, `open`, `remember`, `forget`.
  The first version had five separate search tools; consolidating them into one
  `recall` with a `source` filter is the single biggest quality change in the
  rebuild. Read `tools.ts`'s header before adding a twelfth.

### Traps, each of which has already cost something

- **A hardcoded tool name in a prompt string is a bug waiting.** The text
  protocol's worked example said `memory_search` and survived the rename that
  deleted that tool, so every local model was shown an example calling
  something that did not exist — on the code path least likely to be noticed.
  It is now derived from the catalogue, with tests. Do not reintroduce a
  literal tool name into any prompt.
- **Effort is read by every mode, but `agentSteps` only means something in
  `agent`/`deep`.** An effort blurb that mentioned lookups was describing a
  budget `direct` cannot spend. `effortMeans(effort, mode)` in `lib/effort.ts`
  is the only thing that should phrase this; `EffortBudget.blurb` must stay
  mode-neutral, and `effort.test.ts` enforces that.
- **Anything settable before a conversation exists needs a draft.**
  `ChatContext.update()` returns early with no conversation, so the mode picker
  silently did nothing on first arrival at chat until `draftMode` was added
  beside `draftModel`/`draftEffort`; the capability switches had the identical
  bug until `draftActions`. Any new per-conversation control has the same hole.
  Two halves to the fix, and the second is the one that was missed: the draft
  has to exist, *and* every creation path has to apply it. They all funnel
  through `withDrafts()` now, which reads a ref rather than state — ChatView's
  ctrl+J listener re-registers only when the palette or drawer moves, so it
  otherwise holds a first-render closure and started every new chat with the
  drafts empty. (Known and left alone: all four drafts reset if you navigate
  away from chat and back.)
- **The loop's failure mode is spending, not crashing.** Three budgets guard
  it: `maxSteps`, `MAX_TOOL_CHARS` (12k across the whole message), and per-tool
  caps applied in `runTool` rather than trusted to each tool.
- **Deep mode's close-out nudge fires at most once.** A model that answers with
  plan steps open is handed the list back one time; after that the answer
  stands and `trace.unfinished` records what it skipped. Nagging twice burns
  the budget arguing.

### What is verified, and what is not

Verified in a browser against seeded and real data: the plan and trace render,
the mode picker reports the right per-mode cost, tool filtering (read-only /
scratch / deep) is correct, the generated prompt names only real tools and
round-trips through our own parser, and all six sections still mount.

**Never yet run against a real model.** There is no API key in this
environment, so real streaming, real token and cost totals, and — the important
one — whether a model actually chooses good tools are all untested. That last
is where the system prompt earns or loses its keep. First job with a key: run a
Deep query against a real deck and read the trace.

### Next, in the order the user asked for it

1. **The scratch chat** — a non-project thread for quick unrelated questions.
   Cleanest path is a reserved `system: true` project so `projectId` stays
   non-null everywhere and `chatStore.repair()` keeps working;
   `projectId: string | null` would touch every `db.projects[c.projectId]` in
   the app. `toolsFor({inProject: false})` already handles the tool side.
2. **Restructure the memory panel around `Memory.topic`** — the field and
   `memoryStore.topics()` exist and nothing renders them yet.
3. **The UI/navigation restructure**, to make the project hierarchy visible.

---

## 14. The Figures section — the shelf

Shipped 2026-09-20. CLAUDE.md holds the rules; this is why it exists and what
was decided.

A figure lived only in the reply that drew it, and `lib/visuals/artifacts.ts`
argues well for that: the transcript is already the record, so branching,
regenerating, export and restore all carry a canvas with no code of their own.
The argument holds for a figure *in a conversation* and fails for one you want
back. A thread is a conversation, not a shelf — the diagram that finally made
something clear is four hundred messages back in a thread named for the
question, not for the answer.

Decided, and worth not relitigating:

- **What is kept is the fenced block**, not a rendering of it. One format, one
  renderer, nothing to keep in step; a kept canvas still runs and a kept chart
  still has its slider.
- **A section, not a pane and not a Settings page.** This repo has now put
  useful things in a surface five of six sections could not reach three times
  (§6, and the review Menu). A shelf of study material is content, like Cards.
- **Nothing keeps itself** (locked decision 4). Keep is a button.
- **Identity is the source, except for a canvas** (`lib/visuals/keep.ts`), so
  the second flowchart you keep is a second figure and the rewritten canvas is
  v2 of the first. Superseded sources move into `versions` and are never
  dropped (locked decision 5).
- **Whiteboards are rows on the same page.** They had been saved since the day
  they shipped and listed by nothing at all, so a board could not be reopened
  once its sheet closed. Same page because, from where the learner is standing,
  a diagram they kept and a board they drew are the same kind of thing.
- **Keeping counts as activity** (`figure` in `ACTIVITY_KINDS`), because a
  section invisible to the calendar is the bug §"Activity means every section"
  exists to prevent.

Open: nothing here has been used against a real model.

---

## 15. The day — one description, read by everything

Shipped 2026-09-20, the same day as §14 and for the same reason: the app knew
things it was not telling itself.

`lib/dayBrief.ts` was chat's private answer to "what did I do today", and it
covered three sections — reviews, the journal, and what you had written down.
It missed conversations, exams, notes and kept figures, which is four of the
seven, while `services/activity.ts` had read across all of them for a year. So
the calendar on Home drew a fuller day than the tutor on the next screen could
see.

It is now one record with two renderings — `dayBlocks` for a page, `renderDay`
for a prompt — collected over a **window** rather than "now". Everything reads
it:

- **Chat**, through the `today` source, minus the thread being sent (the
  conversation the model is already reading does not need describing back).
- **The journal writer**, which used to be fed the capture box alone. A day
  spent drilling, working through chat and sitting an exam without typing
  anything produced "Log something first" — the one section whose job is to
  say what happened, refusing because nobody had told it. `writeJournal` now
  takes the record and treats it as fact, with the learner's own words ranking
  above it wherever the two could disagree about meaning.
- **The journal page**, which shows the same blocks above the capture box, so
  what you can see and what the model is given are the same list.
- **The chat empty screen**, which offers the day as a starter when there is
  one — which is also how anyone discovers this exists.

Two decisions worth not relitigating:

- **The window is a parameter.** `dayWindow(day)` closes at that day's
  midnight; `todayWindow(n)` runs to now. Writing up yesterday with a live
  window puts this morning into yesterday's permanent entry, and nothing about
  the entry would look wrong afterwards. `dayBrief.test.ts` is only about this.
- **`services/ai` does not import it.** The brief reaches into six stores and
  that file is in the review loop's entry chunk; the caller passes the rendered
  string in. It is the same boundary the `poolFor` note in `lib/chatContext.ts`
  describes.

Kept figures reached chat at the same time, in the two shapes chat already
has: a `{kind:"figures"}` **context source** (titles and your notes, cheap,
standing) and an `@` **reference** (the fenced block itself, once). A canvas
kept under a name is now keyed project-wide rather than per thread, which is
what makes the loop close — `@` the figure, ask for a change, keep the reply in
whatever conversation you are in, and it is v2 of the one you had.

Cost, honestly: the day brief is bigger than it was and rides on every message
of any thread with `today` attached, and `lib/dayBrief.ts` moved into the
review loop's entry chunk (+6KB raw, +2KB gzip) because two lazy chunks share
it now.
