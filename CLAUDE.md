# Drill — working notes for a new session

Read this first. It is the orientation map, not the documentation: it says
where things are, what will bite you, and how to check your work. The prose
docs are better than a summary of them, so this points at them instead.

| You want | Read |
| --- | --- |
| What the app is, every feature, full file map, setup per backend | `README.md` |
| The rules of the codebase, what a good change looks like | `CONTRIBUTING.md` |
| Why the app is shaped this way, the roadmap, locked decisions | `START-HERE.md` |

`README.md` is the user-facing product doc and is accurate and detailed —
especially its **Project layout** section. Do not restate it here.

---

## Commands

```bash
npm run dev     # vite; usually :5173, falls back to :5174 if taken
npm run lint    # tsc --noEmit. The only lint there is
npm test        # tsx --test src/**/*.test.ts
                # 251 tests: fsrs, cardFormat, memory*, effort, title,
                # thinking, agent/loop, settings/catalogue, logBudget,
                # storage, activity, gaps, retry, budget, ai/structured,
                # weeks, rememberArg, speech/{words, availability, player}
npm run build   # tsc -b && vite build
```

**A dev server's port is part of its origin.** `localhost:5173` and
`localhost:5174` have entirely separate `localStorage` and IndexedDB, so a
second `npm run dev` while one is already running gives you a *fresh empty
app*, not the data you were just looking at. Convenient for testing against
throwaway state; alarming for ten seconds if you do not know it.

Before saying a change is done: `npm run lint && npm test && npm run build`,
and then **look at it in the browser**. See *Verifying* below — this codebase
is almost entirely UI, and three of the last set of bugs typechecked cleanly
and were still completely broken.

## Shape, in one paragraph

Vite + React 18 + TypeScript, frontend-only, no server, no account, no
telemetry. State lives in two module-level singletons that components
subscribe to with `useSyncExternalStore` — `services/store.ts` (decks, cards,
scheduling, projects, settings; persisted to `localStorage` under
`mldrill:v3`) and the IndexedDB-backed stores (`chatStore`, `journalStore`,
`memoryStore`, `examStore`, `candidates`, `usageLog`) in the `drill-chat`
database. `useDrillStore()` binds the first; `useStoreSync(mod)` binds any of
the others. Routing is a ~60-line hash router: `#/p/<projectId>/<view>`, plus
`#/p/<projectId>/chat/<conversationId>`.

## Things that will cost you an hour if you don't know them

**One shell, six sections.** Home, Review, Cards, Journal, Exam and Chat all
render inside `components/Shell.tsx`. The sidebar, the dock and the rail are
*siblings* of the scroll container, never inside it — that is what stops the
navigation scrolling off the page, and it is a rule, not an accident. Putting
navigation inside `.app-scroll` reintroduces a bug this shell was built to
kill.

**There is one project that is not a project.** `#/p/personal` is the space for
chats that belong to no body of work — the ChatGPT-shaped default, next to the
projects rather than inside them. It is a real `Project` record with a literal
id rather than a nullable `projectId`, deliberately: `projects[c.projectId]` is
read in a dozen places and a null there is how you white-screen this app. What
makes it a space and not a project is presentation only — `projects.list()`
leaves it out (read it with `projects.personal()`), the switcher gives it its
own row with no edit or archive, `archiveProject` refuses it, and
`switchProject` lands it on chat. `lib/migrate.ts` creates it, so a restored
backup from before it existed comes back with it.

**Every project is guaranteed a deck of its own, and that is load-bearing.**
`deck()` is read as non-null in a dozen components and `pool()` returns
`[deck()]`. `ensureActiveDeck()` in `store.ts` is the single place that keeps
the promise; the fallback it replaced reached outside the project
(`Object.keys(db.decks)[0]`), so a project with no decks — which is every
project `createProject` has ever made — showed and drilled another project's
cards. Never widen that fallback past `decksOf(activeProjectId)`.

**A crash in `Shell`/`Sidebar` white-screens the whole app.** There is no
error boundary above them, and `Sidebar` now calls `store.counts()` and
`journalStore.unrolledEntries()` on every render in every view. Anything those
touch is effectively a global dependency. Note `store.pool()` returns
`[deck()]` when deck-mixing is off, and `deck()` is `db.decks[db.active]` — an
unresolvable `db.active` yields `[undefined]` and takes down every view at
once, not just Review.

**Tokens only, in the stylesheets.** `styles/tokens.css` owns every colour,
size, radius, shadow and easing, in two printings (`night` default, `day`).
Nothing downstream spells out an `oklch()` or a pixel size, and there is
exactly one label style (`.label`). New styles go in the stylesheet for the
section, not in a `style={{...}}` prop — a component may set a *measured*
value inline (a grid column, a computed `left`), never a look.

**Stylesheets are code-split on purpose.** `style.css` and `tokens.css` load
eagerly from `main.tsx`; `cards.css`, `home.css`, `chat.css` and `views.css`
are imported by the view that needs them so they ride that lazy chunk.
`ChatView` is `React.lazy` because KaTeX + highlight.js are ~450KB and the
review loop is opened every day. Never import chat's rendering stack from
anything the review loop touches — that is what `lib/plaintext.ts` exists for,
as the KaTeX-free counterpart to `lib/markdown.ts`.

**Never string-splice HTML into rendered output.** Walk the DOM. Everything
user- or model-supplied goes through `lib/markdown.ts` (DOMPurify) first.

**A failed write is a value, never a `catch` that logs.** This app has no
server, so a write that does not land is work that no longer exists — and it
looks exactly like success from every seat in the UI, because every number on
screen is computed from memory. Both halves of persistence used to swallow
failures: `store.saveNow()` had a `catch` that called `console.error`, and all
twelve IndexedDB writes had `.catch(() => undefined)` or no catch at all.
localStorage gives an origin ~5MB and the review log grows inside it, so this
was reachable, not theoretical — the user lost hours.

The rules now: `storage.write()` returns a `WriteResult`; `saveNow()` escalates
on quota (shed old recall text, then trim the log, then give up) and keeps
`store.getSaveState()`; every IndexedDB write goes through
`persistence.guard(area, promise)`; and `components/ui/SaveAlarm.tsx` — mounted
by `Shell`, outside `.app-scroll`, in every section — renders any of it. **Do
not add a write that cannot report.** `lib/logBudget.ts` owns what may be shed
and `logBudget.test.ts` enforces that shedding never touches a field the grid,
the streak or retention reads.

**Two tabs overwrite each other completely.** Each holds its own `db` and
serialises all of it on save, so the last tab to close wins. `store` listens
for the `storage` event (which fires only in *other* tabs) and raises the same
alarm. Merging is not attempted — saying so is.

**Activity means every section, and it is derived.** `lib/activity.ts` (pure)
turns timestamps into days, weeks and streaks; `services/activity.ts` gathers
those timestamps from all six sections — reviews, cards written, notes,
journal chunks, conversations, exams, project memory — and memoises the result
against every store's `getVersion()`, because the review rail asks for it on
every grade. **Call `activity.daysFor(projectId)`, never rebuild it.** Nothing
is written down twice, so a day can never disagree with the section it came
from, and history predating the change counts retroactively. It read `db.log`
alone before, so an evening of journal, chat and an exam drew a blank square
and broke the streak — an app telling you a productive day did not happen.
`levelFor` gives anything at all level 1 on purpose: against a 200-review day
a journal entry is 0.5%, and showing up has to be visible or the calendar is a
chart of your heaviest days rather than a record of a habit.

**One scope per screen.** `db.log` is one flat list across every project and
the log is filed by *deck id*. `stats(decks)` and `counts(decks)` both default
to `pool()` — the active deck alone unless mixing is on — so a page that is
about a project must pass `store.projectDecks()` or it prints one scope's
numbers under another's heading. Home did exactly that: "12 reviewed today"
from every project, directly above an activity grid filtered to one. The
streak has one definition, `lib/activity.ts`'s, computed from the log;
`deck.meta.streak` is a per-deck counter that only advances for decks in
`pool()` when `rollover()` runs, and it drifted from the computed one.

**Keyboard bindings live in three places** and `components/ui/ShortcutsModal.tsx`
is the published promise about all of them: `Shell.tsx` (ctrl+B, ctrl+\, ctrl+,
`?`, Escape), `AppShell.tsx` (the review loop: Space, 1–4, G, N, S — all guarded
to not fire while an INPUT/TEXTAREA/SELECT has focus, *or* while settings is
open, since it covers the card it would otherwise grade), and
`ChatView`/`Composer` (ctrl+K, ctrl+J, Enter to send, `/`, `@`, Escape).
**Change a binding, change the modal in the same commit.** A cheatsheet row that
nothing listens for is worse than no row.

Escape is layered, innermost first, and `Shell` owns the outermost layer:
settings, then the shortcuts sheet, then the mobile drawer. `ChatView`
deliberately does *not* handle Escape for settings — if it did, closing the
panel from chat would also clear the message you were writing.

**One composer control is model-dependent, not backend-dependent.** Everything
else in the app asks "can this backend do it"; thinking asks "can this *model*
do it", because one OpenRouter key reaches both kinds and the model chip is one
click away. The answer comes from OpenRouter's `supported_parameters`, which
`services/pricing.ts` already fetches — one catalogue call answers both "what
does it cost" and "can it think". `lib/thinking.ts` turns that into three
states, and the third matters: **not knowing leaves the switch live**. Rounding
`unknown` down to "no" would grey the control out for every local model and for
everybody until the catalogue lands. Only a catalogue hit produces a "no".
Ask `availability(id, supports, model)` in `lib/chatActions.ts` — never
`backend.supports` directly — because the send path filters on the same call
and the two must not disagree.

**One-shot operations are sized, not capped.** Rollup, journal, distill, exam
generation and grading, recall marking, card writing and `/remember` each make
one request and parse the reply, and each used to pass a fixed `max_tokens`
sized for a model that starts writing at once. A reasoning model spends that on
its scratchpad and returns nothing with `finish_reason: "length"` — the weekly
rollup failed that way every single time. They all go through `structured()`
(`services/ai/structured.ts`) now: `lib/budget.ts` sizes the request from the
catalogue's `reasoning` and `maxOutput`, and a reply cut off at the cap gets
exactly one retry with twice the room, on the transcript as "<label> · retry".
Two rules. **The first try never sends a reasoning control** — on a hybrid model
such as Claude through OpenRouter that parameter switches thinking *on* — and
the retry turns reasoning down only when the first reply actually reasoned
(`ReplyCutOff.reasoned`, `FinishInfo`). A complete reply that will not parse is
not retried; more room would not change it. Do not add a one-shot call that
hands `chat()` a bare `maxTokens`. The rollup itself is one week per press
(`lib/weeks.ts`), which bounds its input by construction.

**Chat retries, but never a stream that has spoken.** `lib/retry.ts` owns the
policy (retryable statuses, backoff, `Retry-After`); `postWithRetry` in
`backends.ts` owns the loop and the abortable sleep. The rule that matters is
`started()`: both streaming adapters pass a closure over their own accumulator,
and once one token has reached the caller the request is never repeated —
restarting a stream either duplicates what is on screen or throws it away.
A failure after that point keeps the partial instead: `run()` in ChatContext
saves `acc` as a variant *and* sets `turn.error`, and MessageTurn renders the
reply with a "Cut short" strip under it rather than replacing four paragraphs
with a red box. `send()` guards on `busy` for the same family of reasons — the
composer disables its button, but starters, slash commands, follow-up chips and
the palette all reach `send()` too, and a second `run()` overwrites `abortRef`
and leaves the first request unstoppable.

An assistant turn with no variants and no error is a reply that was in flight
when the app went away; `chatStore.repair()` names it so the UI offers Retry
instead of a blank bubble it used to give a blank variant to.

**The learner model is one description, in one file, fed by the loop.**
`lib/memoryBrief.ts`'s `learnerBlocks()` is the only place that says how a
learner is described to a model — goals, what they are currently getting
wrong, what is remembered. `memoryBrief()` wraps it for `services/ai` (card
writing, marking, journal, distill, exam, the tutor); `buildContext` in
`lib/chatContext.ts` composes it with chat's per-source blocks and wraps once
with `wrapLearner()`. There were two of these, emitting the same banner and a
differently-phrased goals line from different code, so an improvement landed
in one path and not the other.

`lib/gaps.ts` is the fed-by-the-loop half. `AI.markRecall` returns
`missing: [...]` — the most specific thing anything in this app ever says
about what someone does not understand — and it used to be rendered under the
card for a few seconds and dropped. It is on `LogEntry.m` now, clustered into
recurring confusions, and in front of every AI call. **Computed, never
memorised** (§2.6): a confusion that stops recurring stops being mentioned,
which is only free because it is derived from a window of the log. Two traps
if you touch the clustering: match on a *ratio*, not a count of shared words
("chain rule ordering" and "product rule ordering" share two), and match
against each cluster's fixed seed, not its accumulated union, or a gap stops
recognising itself after four recordings. `gaps.test.ts` holds both.

**Backends and credentials.** `services/ai/backends.ts` holds one entry per
provider — OpenRouter, Groq, Ollama, and a generic OpenAI-compatible one — and
anything speaking the OpenAI wire format needs only headers, via
`openAICompatible()`. Two rules that are easy to miss:

- Each entry declares `pricing: "catalogue" | "free" | "unpriced"`, and
  `services/pricing.ts` reads that rather than checking backend ids. Omitting
  it means "unpriced", which is deliberate — a new backend must opt in to
  claiming a price instead of inheriting a `$0` that isn't true.
- `key`/`model`/`baseUrl` are single live fields, mirrored per backend into
  `Settings.creds`. **Only `store.setBackend()` may change `settings.backend`**
  — it stashes the outgoing backend's three fields and restores the incoming
  one's. Assigning `backend` through `updateSettings` skips that and silently
  destroys a key. `RETIRED_BACKENDS` in `store.ts` is how a removed provider
  is retired without deleting the secret its user pasted.

**Singleton components with entity-scoped state need a `key`.** `Composer` is
keyed on the conversation id because otherwise a draft leaks between threads.

**Chat has three modes, and one of them is an agent loop.** `Conversation.mode`
is `direct` (one call, the default) / `agent` (reactive lookups) / `deep` (plan
first, close every step, then answer). The loop lives in `services/agent/` —
read `tools.ts`'s header before touching the catalogue, and START-HERE §13 for
the whole picture. Four things bite:

- **`loop.ts` takes `chat` *and* `runTool` injected.** That is the only reason
  its 28 tests run with no API key and no IndexedDB. Do not "simplify" it by
  importing them.
- **Never put a literal tool name in a prompt string.** One did, survived the
  rename that deleted that tool, and taught every local model to call something
  that did not exist. Derive it from the catalogue.
- **Effort is read by every mode; `agentSteps` only means something in
  `agent`/`deep`.** `EffortBudget.blurb` must stay mode-neutral;
  `effortMeans(effort, mode)` is the only thing that phrases the lookup budget,
  and `effort.test.ts` enforces it.
- **Anything settable before a conversation exists needs a draft.**
  `ChatContext.update()` returns early with no conversation, so a new
  per-conversation control silently does nothing on the empty chat screen until
  it gets a `draft*` beside `draftModel` / `draftEffort` / `draftMode` /
  `draftActions` — and until `withDrafts()` emits it, which is what every
  creation path (send, starters, slash commands, ctrl+J) funnels through.
  `withDrafts` reads a ref, not state, because ChatView's ctrl+J listener is
  re-registered only when the palette or drawer moves and otherwise holds a
  first-render closure.

**Attachments are read here, kept apart, and carried by rule.** Every file —
the chat composer, project knowledge, journal capture — goes through
`services/files/ingest.ts`, which sniffs the bytes (`lib/files/sniff.ts`),
refuses with a sentence, and returns an `Attachment` whose `text` is what the
model reads. Originals (pictures, PDFs, rendered scan pages) live in their own
IndexedDB, `drill-files` — not a `drill-chat` store, for the version-bump reason
the speech cache gives — but unlike that cache every write goes through
`persistence.guard`, because a photo you attached is your work. Three rules.
**What an attachment sends on a turn is `lib/files/carry.ts`'s decision**:
pictures ride as themselves on the newest two user turns (one at low effort)
and pinned ones always, older ones as a line; capability is `lib/modality.ts`'s
three-state verdict, never a model name. **A PDF sent as a file always names its
OpenRouter parser** (`ChatOpts.pdfEngine`) — unnamed, OpenRouter uses its paid
OCR — and Agent/Deep read PDFs locally because the loop cannot name one. **The
run transcript never holds base64** (`forTranscript`). The parsers are dynamic
imports and none may reach the review loop's entry chunk. Dropped files are
*taken* from a queue (`takeDropped`), never passed as a prop: the composer
remounts when the first message creates a conversation, and a prop holding the
files attached every one of them again.

**Reading aloud is one player, two engines, and a cache that is not your
data.** `services/speech/player.ts` is the singleton the Listen button, the bar
above the composer and the sentence highlight all read, and it takes its engine
injected — `player.test.ts` runs the queue with fakes, the same bargain as
`agent/loop.ts`. `choice.ts` is the only place that decides which voice reads
(`lib/speech/availability.ts` holds the pure verdicts in Think's three states:
a list that has not loaded leaves Listen usable), and `AI.speak()` is the only
place a voice is paid for — run transcript, plus the usage ledger under
"listen" with `characters`, because a voice bills per character and reports no
tokens. Four traps:

- **Create the engine inside the click.** `listen()` must run synchronously in
  the handler: the hosted engine spends the gesture on a moment of silence so
  Safari lets the real audio play a second later. An `await` first breaks it.
- **Sentences come from the rendered DOM** (`lib/speech/segment.ts`), and maths
  from the `data-tex` that `restoreMath` stamps on each KaTeX root — KaTeX's
  HTML output keeps no TeX. Touch the markdown pipeline and the voice changes
  with it. `useReadingHighlight` re-segments rather than sharing ranges.
- **The audio cache is its own IndexedDB, `drill-speech`** — capped,
  idle-purged, quota-aware, and deliberately in neither `backup.ts` nor
  `persistence.guard`: a failed cache write loses no work, so it reports on the
  Listening page instead of raising the save alarm. Do not move it into
  `drill-chat`; that is a version bump, and a bump blocks while a second tab is
  open.
- **`AI.speechCreds()` reads the credential vault**, so a voice can use a
  backend chat is not pointed at. It never writes `settings.backend`.

**There is still no error boundary at the root.** A render crash in `Shell`,
`Sidebar`, or a composer chip rendered before its new prop was threaded through
white-screens the whole app. That happened for real while building Phase 12.
`components/ui/ErrorGuard.tsx` is the local version — the sheet router and the
settings body wrap themselves in it, so a pane or a settings page that throws
costs you that panel rather than the session. Wrap anything that renders data
it did not create; it does not help with a crash above it.

## Verifying

There is **no API key in this environment**, so live inference, real streaming,
the abort path and real token/cost accounting cannot be tested. Say so plainly
rather than implying they were. **The agent loop has never run against a real
model** — whether it picks good tools is the open question, and the first thing
to try when a key exists. Everything else can be driven directly:

- Seed state and drive the DOM with the browser tools against `npm run dev`.
  `store` state is `localStorage["mldrill:v3"]`; conversations are the
  `conversations` + `meta` object stores of the `drill-chat` IndexedDB (v4).
  **`db.decks` and `db.projects` are `Record<id, T>`, not arrays** — seeding an
  array there dangles `db.active` and white-screens the app.
- **Clean up seeded data afterwards.** Deleting decks or re-keying a project
  orphans real conversations, which reference `projectId`; the app will happily
  bootstrap a fresh project and starter deck over the top of the user's own.
- Assert on measured DOM values, not screenshots. Screenshots crop and rescale.

### Browser-tool artifacts that look exactly like bugs

The driven tab is `visibilityState: "hidden"`, and that changes real behaviour:

- **`requestAnimationFrame` never fires** and scroll events are not dispatched
  at all. A rAF-driven readout that "does nothing" is usually this. Shim
  `window.requestAnimationFrame` to a timer and remount via the hash router
  (no reload, so the shim survives), then dispatch `new Event("scroll")` by
  hand. `setTimeout` is also clamped to ~1s in the background, so wait longer
  than feels necessary.
- **CSS transitions and animations freeze mid-flight**, so a computed value
  reads as the *previous* state. Inject `* { transition: none !important }`
  before measuring.
- `scrollIntoView({behavior:"smooth"})` is silently dropped. Use `"auto"`.
- The viewport maxes at **1131 CSS px** (150% Windows scaling); `outerWidth`
  lies. Do not put a desktop breakpoint above ~1100px. Test other widths by
  driving the app inside a sized same-origin iframe.
- A page-level `transform: scale()` used to fit a screenshot corrupts every
  `getBoundingClientRect()` measurement. Clear it before measuring.
- **Audio never starts.** An `<audio>` element given a valid blob sits at
  `readyState` 0 firing `waiting` and `stalled`, and `play()` never settles —
  a hosted voice looks stuck on "Preparing…" until the ten-second start
  watchdog turns it into an error. Verify listening up to the element instead:
  stub `fetch` for `/audio/speech` with a generated WAV, count
  `URL.createObjectURL`/`revokeObjectURL`, and read the usage ledger, the
  `drill-speech` cache and `navigator.mediaSession`. For this device's voice,
  replace `window.speechSynthesis` *and* `SpeechSynthesisUtterance` with fakes
  before chat mounts — a real utterance throws when handed a fake voice.
- **A module imported from the console after a hot update is a second copy.**
  Once Vite has served the app a file as `?t=…`, `import("/src/…/player.ts")`
  builds a separate instance with its own state. Take the URL the app really
  loaded from `performance.getEntriesByType("resource")`.
- **`el.blur()` fires no `focusout`**, so a React `onBlur` handler never runs
  and a commit-on-blur field looks like it silently drops the edit. `el.focus()`
  does work — `document.activeElement` confirms it — which makes this
  convincing. Dispatch `new FocusEvent("focusout", {bubbles: true})` by hand.

### React 18 StrictMode is on

Effects mount, clean up, and mount again. Any cleanup that cancels a pending
handle **must also clear the handle**, or the second mount sees a stale
non-zero guard and the work is never scheduled again. And an effect whose
element is conditionally rendered needs that condition in its dependency
array: `.msgs` does not exist on the first render of a conversation opened
straight from its URL, so an effect keyed only on the conversation id attaches
its listener to nothing and never runs again.

## Conventions

- **Comments explain *why*.** The existing ones are unusually good — they
  record the bug a rule exists to prevent. Match that register: full
  sentences, the reason rather than the restatement. Do not strip them.
- Commit straight to `main`. No branches, no PRs on this repo.
- No new runtime dependencies without a reason that survives
  `CONTRIBUTING.md`'s "deliberately not here" list.
- Settings must actually be read by something. A dial that is editable,
  persisted and wired to nothing is a bug, not a placeholder — and so is the
  inverse, which this app has now produced three times: `settings.effort` and
  `settings.autonomy` were the bottom of an inheritance chain the send path
  read while no global control existed, and `settings.sessionSize` was read by
  the rail and by `startSession()` with nothing anywhere able to write it.
  There is a third shape, and it is the one this repo keeps hitting: a real
  control, wired to a real value, in a surface five of the six sections do not
  mount. `settings.mix` was that one.
- **Settings commit on blur. There is no Save button.** There used to be one,
  and it applied to seven of the fifteen controls on the screen while the rest
  wrote through immediately, with nothing saying which was which — so editing
  a number and closing the panel silently discarded it. `ui/TextRow.tsx` is
  the field that keeps the rule; do not add a field that batches into a Save.
- **One settings surface, and it is not a view.** `context/SettingsContext.tsx`
  holds which page is open and, optionally, which group on it to jump to;
  `Shell` renders `settings/SettingsSurface.tsx` once, so the same panel with
  the same navigation appears in all six sections (`ctrl + ,`, the sidebar,
  chat's header button, the review Menu). It is mounted from `Shell` rather
  than the app root deliberately — that is what puts it inside `ChatProvider`
  in chat, so the "This chat" page has a conversation to read. Conversation,
  project and global are one inheritance chain, so they read as one list
  rather than three tab strips.
- **The table of contents is `settings/catalogue.ts`, and it is pure data.**
  Every page and every group on it — name, blurb, and the words search matches
  — is declared there once. `registry.tsx` holds only the half that cannot be
  data (the component to render). `Section` takes a catalogued `id` and reads
  its own heading from it, so a group's words cannot drift from the words that
  find it, and `catalogue.test.ts` fails the build if a page has no groups or a
  group names a page that does not exist. **Add a control, add to that group's
  `finds`** — search returns the *group*, scrolls to it and marks it, and it is
  the second line of defence against the failure that put backup and restore in
  the review loop's Menu, where five of six sections could not reach it.
- **A section's own menu is for that section.** Anything worth opening from
  chat, home, the journal or the exam view is a Settings page, not a pane —
  the review loop's Menu was where backup, the memory browser, the memory tray
  and the run transcript all ended up, which meant they existed from exactly
  one of the six sections. `SheetContext`'s `PaneState` union is the fence:
  a pane is a *review* dialog, and only the review loop mounts a
  `SheetProvider`. What is left in that menu is two review things and
  signposts. Settings pages reach `useMaybeReview()` rather than `useReview()`
  because settings opens far outside the review loop.
- **Two shapes of one rail, at 860px.** Wide, the settings rail is a grouped
  column beside the page, and only the page scrolls — `.set-host` exists
  instead of `.sheet-body` precisely so the search box and the rail stay put.
  Narrow, the identical markup is the row of pills it used to be
  (`.setnav-group { display: contents }`). Do not add a third.
