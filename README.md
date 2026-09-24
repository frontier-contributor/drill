# Drill

Spaced repetition that makes you write the answer before you see it, marks what
you wrote, and schedules the card with FSRS-6. Bring your own API key, or run it
entirely on your own machine with Ollama.

A Vite + React + TypeScript frontend. No account, no server, no telemetry —
your cards and your API key never leave your browser (or `config.local.json`
on your own machine). Deploys as a static site to Vercel's free tier.

---

## Features

### Chat

A full chat client that happens to know what you have been studying. That is
the whole point of it living here rather than in a browser tab pointed at
openrouter.ai.

- **Any backend** — the same OpenRouter / Groq / Ollama / OpenAI-compatible
  picker the rest of the app uses, but chosen **per conversation**, so a cheap
  model can mark recall while a strong one writes cards.
- **It can see your decks** — attach your weak cards, what is due today, a
  whole deck, or your insight log. Context is rebuilt from your real progress
  every time you send, so a thread you return to next week reflects next
  week's gaps.
- **It can see your day** — everything you did, from every section: the cards
  you reviewed and how each went, the sentences you wrote from memory when
  tested, the other conversations you worked in, exams, notes, cards written,
  memories saved, and the figures you kept. "What have I been working on?" is
  a question this answers with facts rather than a guess, and `/today` asks it
  in one keystroke. It is also the first thing a new chat offers you, on a day
  you have already started.
- **Attach what you are studying from** — the **+** on the composer asks what
  kind first, and opens the file dialog on that kind alone. A kind the model cannot read is
  dimmed and says why, before you have picked anything rather than after it has
  been read. Pictures and screenshots (paste, drop anywhere on the chat, or
  pick), PDFs, Word, Excel, CSV, text and code.
  Everything is read in your browser first: a PDF's text with page numbers, a
  spreadsheet as CSV, a Word file with its headings and tables. Pictures go to
  a model that can see, downscaled and with their location data stripped; a
  card warns *before* you send when the model you picked cannot see them.
  Scanned PDF pages are sent as pictures, or read by OpenRouter's parser if you
  choose it in Settings → Chat. Pin a file to keep it on every message in that
  thread; click any card to see exactly what the model was given.
- **It can generate pictures** — switch **Image** on (the picture glyph on the
  composer) and the reply can come back with a picture as well as words. OpenRouter only, and
  only on models that can draw: the switch says which, and says plainly when it
  is guessing. Billed per picture rather than per token, so the Usage page
  counts pictures beside tokens rather than showing an image reply as a row of
  zeros. Every picture has Keep on it, and lands on the same shelf a diagram
  does.
- **It can draw** — Mermaid diagrams, Vega-Lite charts, function plots with a
  slider per parameter, and small SVG drawings, written by the model as text
  and drawn here. No extra request, and it works on every backend including
  Ollama. Each figure saves as SVG or PNG, opens full screen and can become
  flashcards; one that will not draw says why and offers to send the error
  back. Any kind can be switched off in Settings → Chat.
- **It can build something you can poke at** — ask for a simulation, a stepper
  or a widget and the reply carries a small interactive page, running in the
  conversation. It runs in a sandbox with **no network at all** and no reach
  into the app around it, so nothing it was written with can leave this
  browser. Revise it in conversation and the figure keeps every version: step
  back through them, restart it, or save it as an HTML file you can open
  anywhere. Only the newest version is sent back to the model, so a canvas you
  have rewritten five times does not cost five canvases on every message.
- **Keep the good ones** — every figure in a reply has a **Keep** button, and
  what it keeps is the block itself, on a shelf of its own. See **Figures**
  below.
- **A whiteboard, both ways** — `/board` opens one to draw on, and any diagram
  in a reply opens as shapes you can move rather than a picture you cannot.
  Send it back and the model gets two things: the picture, and the board read
  out as "forward → loss", so "what is wrong with my diagram" works on a model
  that cannot see. Its fonts are served from this app, so opening one makes no
  request to anybody.
- **`/map`** — a mind map of what the project holds: the subjects your memories
  are filed under, and what the review loop says you keep getting wrong. Built
  here from what is already known, so it costs nothing and works with no key at
  all — and it opens in the whiteboard.
- **Any reply becomes flashcards** — one click on a message, or select a
  paragraph first. Pick the deck, untick the weak ones, done.
- **Any reply becomes a note** — straight into the insight log.
- **Modes, not personalities** — Tutor, Socratic (never gives the answer),
  Explainer, Feynman check (you explain, it finds the holes), ML researcher,
  Code, or a raw model with no system prompt.
- **Slash commands** — `/quiz` on what's due, `/weak` to attack what you keep
  failing, `/today` for what you have done and what to do next, `/cards`,
  `/explain`, `/feynman`, `/note`, `/board`, `/map`, `/figures`, `/export`,
  and `/remember` — with a fact after it to save that
  fact, or alone to pull what is worth keeping out of the conversation.
- **Proper rendering** — Markdown, LaTeX via KaTeX, syntax-highlighted code
  with copy buttons, tables.
- **The usual platform things** — streaming with a stop button, regenerate
  with variant history, edit and resend, branch a tangent into its own thread,
  full-text search across every conversation, attachments, `ctrl+K` command
  palette, token and cost accounting.
- **It survives a bad connection** — rate limits and gateway errors are retried
  with backoff (respecting `Retry-After`), but never once the reply has started
  arriving, because a stream cannot be resumed. If one dies part-way you keep
  what came through, with a "cut short" note and a Retry; if the tab closes
  mid-reply, the thread says so instead of leaving a blank bubble. A key that
  is simply wrong still fails immediately — retrying that would only make you
  wait for the same answer.
- **Listen instead of reading** — every reply has a Listen button, and nothing
  plays until you press it. The sentence being read is highlighted and kept on
  screen (scroll away yourself and it stops following until you ask), and a bar
  above the composer pauses, skips a sentence either way, changes speed and
  stops. Maths is spoken as maths — "x sub i squared over 2 m" — and code
  blocks are announced rather than read out. Hosted voices come from
  OpenRouter's speech models (Kokoro by default, about a cent for a long
  reply), Groq, or any OpenAI-compatible server; your browser's own voices cost
  nothing and work offline. Only voices that can actually speak from where you
  are get offered, every paid character is on the Usage page, and a replay
  comes from a capped cache for free.
- **Talk instead of typing** — with the box empty, the round button beside it
  (or `ctrl` + `shift` + `v`) starts a voice conversation in place of the
  composer. Say something and stop: it hears the end of your turn, answers out
  loud sentence by sentence while the reply is still being written, and both
  sides land in the thread as you go. Talk over it and it stops and listens —
  and the thread keeps only what you actually heard. Hold Space (or the lock)
  to keep the floor through a long pause. There is no mode to pick: each turn
  decides for itself whether it needs a plain answer, a look through your
  record, a web search or a plan, and the bar says which it chose. **Talk**
  answers in short spoken sentences with nothing on screen; **Show** may put
  code, a figure or a table in the thread and tell you to look. You are heard
  by Whisper on Groq or OpenRouter (fractions of a cent an hour) or your
  browser's own recognition for free, and answered in the voice Listening
  uses. The orb moves with your voice and with its own, and a full-screen view
  is one click away. **Settings → Voice** is where to try it before you need
  it: check the microphone on the same orb and see what it heard, press a
  voice to hear it, name the language you speak, and set how long a pause is.

### Figures

Everything the model drew that turned out to be worth keeping, out of the
thread that drew it. A generated picture is the clearest case for it: it cost
real money, asking again gives you a different one, and it is four hundred
messages back by Thursday. A conversation is a conversation, not a shelf — the
diagram that finally made backprop click is four hundred messages back in one
you named "q about grads".

- **Keep is one press** — on any diagram, chart, function plot, drawing,
  canvas or generated picture in a reply. What is kept is the fenced block itself, so a kept figure
  is drawn by exactly the same renderer as the one in the conversation: a
  canvas still runs, a chart still has its tooltips and its slider.
- **Revisions land on the same shelf** — ask for a canvas to be changed, press
  Keep again, and it becomes v2 of the one you already have rather than a
  second copy. Every earlier version is still there, behind an arrow. Nothing
  is ever replaced.
- **Say why you kept it** — a line of your own under each one, searched along
  with the title and the figure's own source.
- **Whiteboards live here too** — including the ones you drew from chat, which
  until now were saved and listed by nothing at all. Start a new one from this
  page, or reopen any of them to keep drawing.
- **It goes somewhere** — turn a kept figure into flashcards, open the
  conversation it came from, or start a new thread that already has it in the
  history so you can ask about it. Export is the same SVG / PNG / HTML it
  always was.
- **Chat knows what is on the shelf** — every thread can see the titles of what
  you kept and the notes you wrote about them, so "the diagram I kept" means
  something. Type `@` and pick one to hand over the figure itself; ask for a
  change, press Keep on the reply, and it becomes the next version of the one
  you already had — even from a different conversation.
- **It counts as a day** — keeping a figure lights up the square on Home, like
  everything else in every other section.

### Journal

A day, written up — and it no longer depends on you remembering to type
anything.

- **The record** — above the box you write in, every day carries what the app
  logged for it: cards reviewed and how they went, conversations, exams, notes,
  cards written, figures kept. Open it and you are reading exactly what the
  journal writer will be given, word for word.
- **Write it from either half** — what you typed, what actually happened, or
  both. A day spent drilling, arguing through a derivation in chat and sitting
  an exam without typing a word used to produce "Log something first"; it now
  writes up from the record, and your own words simply outrank it wherever the
  two could disagree about meaning.
- **Capture anything, any time** — type it, drop a file on it, or let a
  `/remember` from a conversation file itself under the day it happened.
- **Bring in a session from another AI** — **From another AI…** gives you a
  prompt to paste at the end of a conversation in ChatGPT, Claude, Gemini or
  anything else. It knows the project: its goal, what you keep getting wrong,
  the tags your cards use. Paste the reply back and Drill reads it locally, no
  key and no call, into cards, notes, memory proposals and a line in today's
  log, each reviewed before anything is saved. It copes with what a chat app
  does to JSON on the way through a clipboard, and with a model that ignores
  the format and writes Q:/A: pairs instead.
- **It goes somewhere** — distil an entry into memories and flashcards, both
  proposed and neither saved until you pick them; roll a week up into a summary
  that also proposes what to merge and retire in memory.

### Review

- **FSRS-6 scheduling** — the algorithm Anki ships. Models each card's memory
  *stability* and *difficulty* separately instead of one blunt ease factor, and
  aims every interval at your target retention.
- **Free recall** — you type the answer from memory before the card flips.
  Recognising an answer is not remembering it.
- **AI marking that remembers** — the model compares your attempt to the card,
  names what you left out, and *suggests* a grade. You still press the button.
  What it named is kept: it sees your history with that card next time ("you
  are making the same substitution error"), and the phrases it keeps writing
  down are clustered into what you are currently getting wrong.
- **Every AI call knows your gaps** — that cluster goes into the system prompt
  of the card writer, the marker, the exam generator, the tutor, chat and the
  follow-up suggestions. Cards get written at the thing you keep missing rather
  than at the topic in general. The rail beside the card shows you the same
  list, so what the app tells you and what it tells the model are one answer.
- **An exam on what you keep getting wrong** — **Examine me on these** under
  that list (or *Aim at → What I keep getting wrong* on the Exam page) builds
  an exam from those mistakes and the cards they happened on, leeches and
  lapsed cards after them. Mistakes from marked exam answers join the same
  list, so a confusion you showed in an exam counts as much as one you showed
  in Review. Every question tests one of them from a different angle than the
  card that caught it, because re-asking the card only tests the card.
- **Interleaving** — consecutive cards from the same section get shuffled apart,
  and "Mix all decks" drills everything due together.
- **Leech repair** — a card that lapses four times gets flagged, and the fix
  button splits it into atomic cards instead of grinding it again.
- **Insight log** — press `n` any time. Any entry turns into cards with one tap.
- **AI tutor** — "Go deeper" under any revealed answer, with three starters. If
  you wrote a recall attempt, it opens by critiquing *that*.

### Home

- **A calendar of everything** — a year of days, one square each, and a square
  counts *anything* you did in the project: cards reviewed and written, notes,
  journal entries, conversations, exams, memories saved, figures kept. Hover a
  day to see what it held.
- **Today, in one row** — what you have done so far, broken down, each count a
  door into the section that produced it.
- **One streak** — computed from that same calendar, so it survives a day you
  spent writing rather than drilling, and reads the same on Home, in the review
  rail and on the finish screen.

### Settings

One panel, the same one from every section (`ctrl + ,`), and everything is
in it — no section keeps a settings menu of its own.

- **Eleven pages, grouped** — Connection, Chat, Voice, Listening and Memory;
  Review and the project; Appearance, Usage and Data. Plus **This chat** while
  you are in a conversation, because a thread, a project and the app are one
  inheritance chain and every row says which level its value came from.
- **Search finds the control, not the page** — type "backup", "retention",
  "delete deck" or "what did it send" and it takes you to the group that holds
  it, and marks it.
- **No Save button** — every field commits when it loses focus or on Enter.
  There used to be one, and it applied to seven of fifteen controls.
- **Memory is a page** — the policy, what is waiting to be saved, and every
  fact it already holds: editable, pinnable, retirable.
- **Usage and the run transcript** — what every call cost, and exactly what
  each one sent and got back.

---

## Quick start

```bash
git clone https://github.com/YOUR-USERNAME/drill.git
cd drill
npm install
npm run dev
```

Opens at `http://localhost:5173` (or wherever Vite prints). Paste an API key
under **Settings → Connection** (sidebar, or `ctrl + ,` from anywhere) and you
are running. Everything below is optional.

> **One rule: always open it the same way.** Browsers store your progress per
> origin. `http://localhost:5173` in dev and your deployed URL are two
> different stores. Pick the one you use day to day, and export a backup
> before switching (**Settings → Data → Back up everything**), and restore it
> on the other side from the same page.

### Deploying to Vercel

Drill is a static site — `npm run build` produces `dist/`, and that's the
whole deployment.

1. Push the repo to GitHub.
2. [Import it on Vercel](https://vercel.com/new) — the free tier is plenty.
   Vercel auto-detects the Vite framework preset; `vercel.json` in this repo
   pins the build command and output directory so it works even if it
   doesn't.
3. No environment variables are required. Every credential is typed into
   Settings by whoever is using the deployed app and stored in *their*
   browser — nothing is baked into the build or read from the server.

Or from the CLI:

```bash
npm i -g vercel
vercel
```

There is no backend to configure. If you later add one (see
[Project layout](#project-layout) below), that's the point at which you'd
start setting Vercel environment variables and adding API routes.

### Configuring by file instead

Typing the key into Settings is enough. If you would rather keep it in a file
— to move between machines, or to pin a model for everyone on a shared
deployment:

```bash
cp public/config.json public/config.local.json
```

Edit `public/config.local.json`. It is gitignored, so your key never gets
committed, and it is never bundled into the production build — Drill fetches
it at runtime, so it also works dropped next to a deployed `dist/` build.

```json
{
  "inference": {
    "type": "openrouter",
    "apiKey": "sk-or-v1-...",
    "model": "anthropic/claude-sonnet-4.5"
  }
}
```

Settings you change inside the app always beat the config file, so a shared
`config.json` can ship defaults without pinning anyone to them.

---

## Setup guides

### OpenRouter — easiest

One key, every model, including free ones.

1. Get a key at [openrouter.ai/keys](https://openrouter.ai/keys)
2. **Settings → Connection** (sidebar, or `ctrl + ,`), leave the backend on
   **OpenRouter**, paste the key
3. **Load model list**, pick a model, **Test**

`anthropic/claude-sonnet-4.5` writes the best cards. `google/gemini-2.5-flash`
or `deepseek/deepseek-chat` are cheap for marking. There are `:free` models on
the list too.

```json
{ "inference": { "type": "openrouter", "apiKey": "sk-or-v1-...", "model": "anthropic/claude-sonnet-4.5" } }
```

### Groq — fast, and free within a rate limit

Groq speaks the OpenAI chat format, so everything works: streaming, the model
list, card writing, recall marking.

1. Get a key at [console.groq.com/keys](https://console.groq.com/keys)
2. **Settings → Connection → Where inference runs → Groq**, paste the key
3. **Load model list**, pick a model, **Test**

```json
{ "inference": { "type": "groq", "apiKey": "gsk_...", "model": "llama-3.3-70b-versatile" } }
```

The free tier limits **tokens per minute**, not requests, and Drill sends large
prompts when a conversation has a whole deck or the day's brief attached. A
429 from Groq is almost always that, not a billing problem — wait a minute or
attach less. Cost readouts show `$0`, which is a statement about the free tier
rather than a lookup; see `pricing` in `src/services/ai/backends.ts` if you
move to a paid plan.

### Ollama — local, free, offline

Nothing leaves your machine and there is nothing to pay for. (Only works when
running Drill locally — a Vercel deployment can't reach `localhost:11434` on
your machine unless you're the one visiting it.)

1. Install [Ollama](https://ollama.com/download) and pull a model:

   ```bash
   ollama pull llama3.1:8b
   ```

2. **Let the browser talk to it.** This is the step everyone misses. Ollama
   refuses cross-origin requests by default, and a browser page counts as one:

   **Windows** — set it once, then restart Ollama from the tray:
   ```bash
   setx OLLAMA_ORIGINS "*"
   ```

   **macOS / Linux** — for the current shell:
   ```bash
   OLLAMA_ORIGINS="*" ollama serve
   ```
   To make it stick on macOS: `launchctl setenv OLLAMA_ORIGINS "*"` then restart
   Ollama. On Linux with systemd: `systemctl edit ollama.service`, add
   `Environment="OLLAMA_ORIGINS=*"`, then `systemctl restart ollama`.

3. **Settings → Connection → Ollama (local)**, set the model to what you pulled,
   **Test**.

```json
{ "inference": { "type": "ollama", "model": "llama3.1:8b", "baseUrl": "http://localhost:11434" } }
```

No key needed. Drill uses Ollama's `/api/chat` endpoint rather than
`/api/generate`, because it sends real conversations — system, user and
assistant turns — and `/api/generate` would flatten all of that into one string.

**What to expect from a small model.** An 8B model marks recall attempts
acceptably and is fine for the tutor. Card *writing* is where the gap shows: it
will drift out of house style and sometimes return prose instead of JSON. If you
have the memory, a 14B–32B model is a real step up for that one job. You can
keep a hosted model for writing cards and switch to Ollama for everything else —
the backend picker is one dropdown.

### Anything OpenAI-compatible

llama.cpp's server, LM Studio, vLLM, text-generation-webui, a company gateway:

```json
{ "inference": { "type": "custom", "baseUrl": "http://localhost:8080/v1", "model": "local-model", "apiKey": "" } }
```

Point `baseUrl` at the `/v1` root. The key is optional.

---

## Using it

- **✦ From a topic** — "logistic regression: sigmoid, decision boundary, log
  loss" → 10 cards in the house style of your existing deck. Untick the weak
  ones before they land.
- **✦ From notes** — paste a lecture transcript or a textbook section.
- **Go deeper** — under any revealed answer, with three starters: why is this
  true / test me on it / where does it show up next. Tutor language switches
  between English and Hinglish in Settings; cards stay English.
- **Where you're at** — true retention over 30 days, what is coming due, and how
  solid the deck is. If retention sits below your target, the cards are usually
  overloaded, not the intervals wrong.
- **Example decks** — **Settings → Data → Example decks**. Reads
  `public/decks/examples/`.

### Keyboard

Press `?` anywhere for this list in the app.

**Anywhere**

| Key | Does |
| --- | ---- |
| `ctrl` + `b` | show or hide the navigation |
| `ctrl` + `\` | show or hide the right-hand panel |
| `?` | keyboard shortcuts |
| `esc` | close what's open, or leave the box you're typing in |

**Review**

| Key | Does |
| --- | ---- |
| `space` | flip the card |
| `ctrl` + `enter` | check your written recall |
| `1` `2` `3` `4` | again · hard · good · easy |
| `g` | go deeper with the tutor |
| `n` | insight log |
| `s` | where you're at |
| `esc` | close |

**Chat**

| Key | Does |
| --- | ---- |
| `enter` | send |
| `shift` + `enter` | newline |
| `/` | slash commands (at the start of a message) |
| `ctrl` + `k` | command palette — jump to any conversation |
| `ctrl` + `j` | new chat |
| `esc` | close whatever is open |

**Listening** — while a reply is read with a hosted voice, the media keys on a
keyboard or headphones pause and resume it and skip a sentence either way.

**Voice** — `ctrl` + `shift` + `v` starts or ends a call. During one, hold
`space` to keep the floor (and to cut in while it talks), `m` mutes, and
`esc` leaves full screen and then ends the call.

---

## Card format

```json
{ "name": "ML — Course 1",
  "cards": [ { "tag": "Notation", "q": "<code>m</code>",
               "a": "<p>Number of <strong>training examples</strong>.</p><div class='shape'>m = X.shape[0]</div>" } ] }
```

`q` allows `<code>` and `<strong>`. `a` allows `<p> <strong> <em> <code> <var>
<sub> <sup>`, plus `<div class="formula">` for a centred formula and
`<div class="shape">` for code, array shapes or literal output. Anything
scripty is stripped on import, whatever the source.

**Maths is LaTeX.** A `formula` block holds bare LaTeX; inline maths goes in
single dollars (`$\alpha$`). It is typeset with KaTeX, loaded on demand — a
deck with no maths never downloads it. Cards that arrive in some other shape —
markdown fences, backticks, `\(…\)`, a bare `\frac` in prose — are converted on
the way in by `src/lib/cardFormat.ts`, so a model that ignores the house style
still produces readable cards.

Full spec, including the house style the card writer follows:
[public/decks/README.md](public/decks/README.md).

---

## Project layout

```
index.html            Vite entry point
src/
  main.tsx             mounts <App/> under RootGuard (components/Rescue.tsx),
                       the page that stands in for a white one
  App.tsx              boot, then the two views (review is eager, chat is lazy)
  types.ts             shared types for the review half
  types/chat.ts        conversations, turns, variants, context sources
  lib/                 pure logic — no DOM, no React
    util.ts             shared helpers
    config.ts            config layering (defaults -> config.json -> config.local.json)
    fsrs.ts               FSRS-6. Pure: no DOM, no storage, no globals
    seed.ts                the starter deck, embedded so a first run needs no network
    plaintext.ts           markdown -> text. Split from markdown.ts so the review
                            loop does not pull in KaTeX and highlight.js
    markdown.ts             markdown + KaTeX + highlight.js + DOMPurify
    personas.ts             the chat modes and their system prompts
    chatContext.ts          decks/weak cards/notes -> a system-prompt block
    tokens.ts               token estimation and cost formatting
    budget.ts               how many tokens a one-shot operation gets, and the retry
    files/                  attachments, pure: what a file really is, limits, CSV and
                             Word text, and what each attachment sends on each turn
    visuals/                figures, pure: the catalogue of kinds, the prompt that
                             teaches them, the function-plot compiler, the page a
                             canvas runs in, the canvas versions in a thread, what
                             keeping one on the shelf means, a whiteboard read out
                             as text, and the concept map
    speech/                 what a reply sounds like: maths to words, sentences,
                             chunking, and which voice can speak (all pure but
                             segment.ts, which reads the rendered reply)
    voice/                  voice mode, pure: when a turn ends, a streaming reply
                             as things to say, what is noise or echo, the Talk
                             and Show instructions, and 16 kHz WAV
  services/
    storage.ts          review persistence — localStorage today; swap this file
                         if Drill ever grows a real backend. Also when the last
                         backup was made, and the rescue page's raw download
    autoBackup.ts        the folder Drill backs itself up into (File System
                         Access API), its own tiny database for the folder
                         handle, and the rotation that prunes only its own files
    store.ts             the Drill database: decks, cards, scheduling, stats.
                         A module-level singleton, subscribed to via useDrillStore
    idb.ts               a small promise wrapper over IndexedDB
    chatStore.ts         conversations: CRUD, search, export. Persists to IndexedDB
                         because transcripts are far too big for localStorage
    pricing.ts           per-model pricing, when the backend publishes it — and
                         the separate speech catalogue, priced per character
    speech/              reading aloud: the one player, its two engines (the
                         browser's voice, hosted audio) and the capped cache,
                         which is its own IndexedDB and never in a backup
    voice/               voice mode: the microphone (an AudioWorklet), the ears
                         (hosted Whisper or the browser's own), the mouth over
                         the Listen engines, and the session that ties them —
                         every part injected, so a whole call is testable
    files/               attachments: one reader for every file (pdf.js, mammoth,
                         read-excel-file, all loaded on demand), the drill-files
                         store for originals, and the sweep for unused ones
    visuals/             figures: Mermaid and Vega-Lite loaded on first use, the
                         colours read back from the tokens, and the SVG sanitiser
    figures.ts           the shelf: figures you kept and whiteboards you drew,
                         both in the drill-files database, one subscription
    boards/              whiteboards: Excalidraw loaded on demand with its fonts
                         served from here, and what a board is made from and
                         turned into
    ai/
      backends.ts         one adapter per inference provider (+ abort, usage)
      index.ts            resolve() + chat() + card writing / marking / titles.
                         This is the file to redirect first if inference ever
                         moves behind a server route
  context/              route, sheet pane, review loop, chat orchestration,
                         settings (which category is open), toasts
  hooks/                useDrillStore — the React binding onto the store singleton
  components/           the review loop and every sheet pane
    chat/               the chat platform
    visuals/            the figure frame, the canvas sandbox and the whiteboard —
                         shared, because chat and the Figures section draw the
                         same block with the same components
    figures/            the shelf: what you kept, and one of them on its own page
    settings/           one settings panel for every section. catalogue.ts
                         declares every page and every group on it — names,
                         blurbs and the words search matches — as pure data;
                         registry.tsx joins that to the components; Section
                         reads its heading from it; SettingsSurface is the
                         window, mounted once by Shell
  styles/
    tokens.css           the design system: two printings, one type/space/radius
                          scale. Nothing downstream spells out a colour or a size
    style.css            the shell, the running head, the page, and every
                          surface shared across every section
    views.css            journal + exam            (lazy)
    chat.css             chat                      (lazy)
    voice.css            voice mode                (lazy, with chat and settings)
    home.css             home, and the chapter opening cards and figures share
    cards.css            cards — and the toolbar and pills figures reuses (lazy)
    figures.css          the figure frame, drawn by chat and by the Figures
                          section, plus that section's own furniture   (lazy)
public/
  decks/examples/       importable decks + index.json
  config.json            committed template — no secrets
  config.local.json      yours, gitignored
tools/                  two tsx scripts for regenerating generated files
vercel.json             build command, output directory, SPA rewrite
```

Routing is a hash router (`#/p/<project>/<view>`, plus a conversation, day,
exam or figure id) in ~60 lines rather than a dependency: every route is a
project, a section and at most one id.

**One book, seven sections.** Home, Review, Cards, Journal, Exam, Chat and
Figures are chapters of one document, not seven apps: they share a shell
(`Shell` > `Sidebar` + `.app-main` > `.app-scroll` > `.page`), a type scale, a
measure and one button system.

The sidebar is that navigation, and it has three states out of one element:
open (17rem), collapsed to a 56px icon rail (remembered in
`Settings.navCollapsed`, toggled by the panel button or ctrl/cmd + B), and —
under 900px — a drawer that slides in over the page. Chat hangs its
conversation index underneath the section list rather than opening a second
sidebar of its own. Because the sidebar and any docked footer are siblings of
the scroll container rather than children of it, no amount of page content can
carry the navigation off the screen.

Two printings — `night` (warm dark, the default) and `day` (warm paper) — are
the same design with the ink and the paper swapped. `Settings.theme` is written
to `:root[data-theme]` by `lib/theme.ts`, and again by a tiny inline script in
`index.html` before first paint so nobody sees the wrong one flash. Everything
downstream composes tokens, so neither printing has a stylesheet of its own.

The chat view is `React.lazy`-loaded. KaTeX and highlight.js are ~450KB, and
the review loop — the thing you open every day — should not pay for them.

**Frontend-only, structured to grow a backend later.** Three files talk to the
outside world: `services/ai` (inference providers), `services/storage.ts`
(review state) and `services/idb.ts` (conversations). If Drill ever needs a
real backend — shared decks, server-side API keys, multi-device sync — those
are the seams: point the two storage modules at a `fetch()`-based API, and/or
add server routes that `services/ai/index.ts` calls instead of hitting
providers directly from the browser. Nothing above them needs to change.

---

## Troubleshooting

**"Could not reach Ollama…"** — either Ollama is not running, or `OLLAMA_ORIGINS`
is not set. See the Ollama section above. Check it is up with
`curl http://localhost:11434/api/tags`.

**404 for `config.local.json` in the console** — normal. Drill probes for the
file and carries on without it. Create `public/config.local.json` and it goes
away.

**Drill looks empty and my cards are gone** — you opened it from a different
origin. `http://localhost:5173` in dev and your deployed URL have separate
stores. Go back to the one you were using. Nothing is deleted.

**"rejected the key (401)"** — wrong key, or the right key for a different
backend. The backend dropdown and the key have to match.

**"404 — usually a model name that does not exist"** — check spelling against
**Load model list**. For Ollama, `ollama pull` it first.

**Card writing returns prose instead of cards** — the model is too small or too
chatty. Try a stronger one; that one job is worth the better model.

**My progress is only in one browser** — that is by design; there is no server.
**Settings → Data → Back up everything** writes decks, scheduling, chats,
journal, memory and usage to one JSON, and **Restore from a backup…** on the
same page reads it back, showing you what it replaces first. Progress survives
restarts but not clearing site data. In Chrome and Edge, **Automatic backups →
Choose a folder…** makes Drill write that file into a folder by itself — one a
day, the last two weeks kept — and a folder your Drive or Dropbox client
already syncs takes it off the machine too. Everywhere else, Home says so when
your last backup is more than a week old.

**"Drill could not start — your saved data is here, but it could not be
read"** — the stored database is damaged or from a shape this version does not
know. Nothing has been written over it. **Download the saved data** first (it
is the bytes exactly as stored, with your API key blanked), then decide; a file
can be repaired by hand or read by a later version. **Start over without it**
asks twice.

**"This page failed to draw"** — something on the screen threw while drawing.
Your saved work is untouched: **Try again**, go to Review or Home, or reload.
**Copy details** is what to paste into an issue. If it says *Drill has been
updated* instead, the tab is older than the site — reload.

**A session's work disappeared / my streak reset** — read the banner across the
top of the app if there is one; it says which of these happened.

- *"Drill cannot save to this browser."* The store this browser gives a site is
  full, or switched off. Nothing has been written since the time it names, and
  it will go when the tab closes. Download the backup it offers **first**, then
  fix the cause. Drill sheds the recall text from old reviews automatically to
  buy room; when that is not enough it says so instead of carrying on quietly,
  which is what it used to do.
- *"Drill is open in another tab."* Each tab keeps its own copy of everything
  and saves all of it, so the last one you close overwrites the others. Close
  the rest and reload. This is the one that looks the most like magic.
- *No banner at all, and it happened while the app was closed.* The browser
  evicted the site. **Settings → Data → Ask now** gets it to promise not to —
  press the button rather than trusting the automatic request, because Firefox
  raises a prompt and a prompt with no click behind it is dismissed unseen.

**The activity calendar is blank but I have been working** — the calendar, the
streak and every figure on Home are scoped to the project in the sidebar, and
the review log is filed by deck. If your work belongs to another project, Home
says so under the grid instead of showing an empty year; switch project in the
sidebar. The calendar counts every section, not just reviews, so a day spent
in the journal or in chat still fills a square.

**My conversations are gone but my cards are fine** — they live in different
stores. Cards are in localStorage; conversations are in IndexedDB, because
transcripts are far larger than localStorage's quota allows. Clearing site data
takes both; a private window has neither. Export a conversation you care about
with `/export`.

**Maths shows as raw `$…$`** — the model wrote it inside a code fence, where it
is left alone deliberately. Ask it to use `$$…$$` on its own line.

---

## Privacy

No telemetry, no analytics, nothing phones home. Your cards and progress live in
your browser's localStorage, your conversations in its IndexedDB, and neither
goes anywhere else. That is also the whole of the durability story, so Drill
asks the browser for persistent storage (again, from a button, in
**Settings → Data**), shows how full the small drawer is, and puts an alarm
across the top of every section the moment a write fails rather than logging it
to a console you do not have open. Your API key is stored in the same browser (or in
`config.local.json`, which is gitignored) and is sent only to the backend you
picked. With Ollama or llama.cpp, nothing leaves the machine at all.

Nothing Drill exports contains your key. Backups and deck exports are written
with the credentials stripped out, so a backup is safe to keep in a synced
folder or attach to a bug report; restoring one leaves the key already in that
browser alone rather than overwriting it with a blank.

One thing worth being explicit about: when you attach deck or insight-log
context to a conversation, those cards and notes are sent to whichever
inference provider that conversation is pointed at. That is the feature working
as intended, but it is your material leaving your machine — if that matters for
what you are studying, point the conversation at Ollama.

The same goes for reading a reply aloud: a hosted voice is sent the reply's
text. Your browser's own voice keeps it on the machine — pick it under
**Settings → Listening**.

And for voice mode: what you say is recorded in this browser and, with a hosted
engine, sent to Groq, OpenRouter or your own server to be transcribed. The
browser's own recognition sends it to whoever makes the browser (Google for
Chrome, Apple for Safari) unless the browser runs it on the device. Choose
under **Settings → Voice**. Nothing is recorded while voice mode is off, except
during the microphone check on that page, which closes itself after thirty
seconds.

---

## Contributing

Backends, decks and bug reports all welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md). Adding a backend is one object in
`src/services/ai/backends.ts` with two methods.

## Contact

Bugs and feature requests are best as
[GitHub issues](https://github.com/AayushtheCoder01/drill/issues), so the
answer is there for whoever hits the same thing next. For anything else —
questions, ideas, or if you are using Drill for something and want to say so —
mail <aayushkumarkumar1234@gmail.com>.

## License

MIT — see [LICENSE](LICENSE).
