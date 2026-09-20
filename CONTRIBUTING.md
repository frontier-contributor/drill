# Contributing to Drill

Three things are especially welcome: **backends**, **decks**, and **bug reports
with a card that reproduces the problem**.

Drill is a Vite + React + TypeScript app, deployed as a static frontend (no
backend, no account, no server-side state). Clone it, `npm install`, `npm run
dev`.

## Ground rules

- **Frontend only, on purpose.** No API routes, no server-side secrets. If a
  backend needs an SDK, call its REST API with `fetch` instead — they all
  speak HTTP, and every backend call already runs straight from the browser
  to the provider. See `src/services/ai/backends.ts` for the note on how this
  boundary would move server-side if Drill ever grows one.
- **No telemetry.** Nothing phones home, ever. No analytics, no error
  reporting, no version checks.
- **No secrets in the repo.** `public/config.local.json` is gitignored. Check
  `git status` before you commit.
- **Typed.** New code should have real types, not `any` escape hatches, unless
  you are wrapping an untyped third-party response shape.
- **Match the file you are editing** — its comment density, its naming, its
  idiom.

## Project layout

```
src/
  lib/            pure logic — util, fsrs, config, seed deck, markdown, personas,
                   activity (days, streaks, the calendar). No DOM, no React, no
                   services: services/activity.ts gathers the timestamps, lib
                   turns them into days.
  services/
    store.ts       the Drill database: decks, cards, scheduling, stats. A module-level
                    singleton (not React state) so any component can read/write it.
    storage.ts      review persistence — localStorage today, swap for a backend later.
    idb.ts          promise wrapper over IndexedDB.
    chatStore.ts    conversations. Same singleton+subscribe shape as store.ts, but
                     persisted to IndexedDB — transcripts are far too big for
                     localStorage's per-origin quota.
    figures.ts      the shelf: kept figures and whiteboards, over drill-files.
    pricing.ts      per-model pricing, where the backend publishes it.
    ai/
      backends.ts   one object per inference provider (OpenRouter, Groq, Ollama, custom).
      index.ts      resolve() + chat() + card writing / marking / titles / follow-ups.
  context/          React context: route, sheet pane, review loop, chat, toasts.
  components/       the review loop (Header, Ladder, Stage, Controls) and every sheet pane.
    Shell.tsx       the frame every section renders into; owns the sidebar state.
    Sidebar.tsx     the one navigation — open / icon rail / mobile drawer.
    ui/Icon.tsx     the whole icon set, one grid and one stroke weight.
    chat/           the chat platform.
    visuals/        the figure frame, the canvas sandbox and the whiteboard —
                     shared, because chat and Figures draw the same block.
    figures/        the shelf: figures kept out of a thread, and whiteboards.
    settings/       the one settings panel. catalogue.ts declares every page and
                     every group on it as pure data — names, blurbs, and the words
                     search matches — and is the only place to add either.
  styles/
    tokens.css      the design system: two printings + the type/space/radius scales.
    style.css       shell, running head, page, and every shared surface.
    views.css       journal + exam.  chat.css  the chat section.
    figures.css     the figure frame — chat and Figures both import it. All lazy.
  types.ts          shared types for the review half.
  types/chat.ts     conversations, turns, variants, context sources.
tools/              two tsx scripts that regenerate generated files.
public/
  decks/examples/   importable decks + index.json.
  config.json       committed template — no secrets.
  config.local.json yours, gitignored.
```

### Three rules that are easy to break by accident

**Compose tokens; never inline a value.** `tokens.css` holds every colour,
size, space, radius and duration in the app. A rule that spells out `#2b2723`,
`13.5px`, `letter-spacing: .14em` or `border-radius: 12px` is a bug even when
it looks right, because it will look right in exactly one printing at exactly
one density. If the value you need is not in the scale, add the step to
`tokens.css` — the scales are deliberately short (nine type sizes, eight
spaces, three radii) and adding a tenth should feel like a decision.

Two corollaries that cost the most time when broken: a new button is `.btn`
plus a modifier, not a new class (the base sets `background`/`border`/`color`
from `--btn-bg`/`--btn-edge`/`--btn-fg`, so a class that only sets those
variables without being in the base selector list renders unstyled); and every
section renders inside `Shell`, because the sidebar and the dock being
siblings of `.app-scroll` rather than children of it is the only reason
navigation cannot be scrolled away.

One more trap specific to the sidebar: it must not carry `overflow: hidden`.
The collapse animation wants to clip labels, but the project popover has to
escape the 56px rail — so the clipping lives on `.nav-head`, `.nav-extra`,
`.nav-item` and `.proj-switch-btn` individually, never on `.nav`.


**Do not import `lib/markdown.ts` outside the chat view.** It pulls in KaTeX
and highlight.js (~450KB), and the chat view is lazy-loaded specifically so the
review loop never downloads them. If you only need to strip markdown syntax,
import `lib/plaintext.ts`. Check with `npm run build`: the review chunk should
stay around 250KB.

**Never splice HTML into rendered model output by string replacement.**
`markdown.ts` renders maths by walking the sanitised DOM (`restoreMath`)
rather than doing `html.replace(token, katexHtml)`. That is not stylistic — a
string replace cannot tell a token in prose from one that landed inside an
attribute value, and malformed markdown from a model puts them there, at which
point the injected markup breaks out of the attribute.

## Adding a backend

This is the easiest useful contribution. Everything lives in
`src/services/ai/backends.ts`.

A backend is one `BackendDef` in `BACKENDS` that describes itself and
implements two methods. `messages` always arrives in the OpenAI shape —
adapters translate outward from that.

```ts
myservice: {
  id: "myservice",
  label: "My Service",
  needsKey: true,
  local: false,
  keyUrl: "https://myservice.example/keys",
  defaultBaseUrl: "https://api.myservice.example/v1",
  defaultModel: "my-model-small",
  note: "One line shown under the picker in Settings.",

  async chat(messages, opts, ctx) {
    // ctx  = { apiKey, model, baseUrl, headers } — already resolved
    // opts = { temperature, maxTokens, onToken, onUsage, signal }
    // Resolve to the reply as a plain string.
    // If opts.onToken is set, stream: call opts.onToken(chunk, accumulated).
    // Pass opts.signal to fetch, and rethrow AbortError unchanged — the chat
    //   view's stop button relies on it staying recognisable.
    // Call opts.onUsage once with token counts if the API returns them.
  },

  async listModels(ctx) {
    // Resolve to an array of model id strings, for the Settings datalist.
  }
}
```

Then add the id to `BACKEND_ORDER` (and to the `BackendType` union in
`src/types.ts`) so it appears in the dropdown.

**If your service speaks the OpenAI chat format**, you do not need to write
either method. Wrap the shared implementation and supply only the headers:

```ts
myservice: {
  id: "myservice", label: "My Service", needsKey: true, local: false,
  keyUrl: "…", defaultBaseUrl: "…", defaultModel: "…", note: "…",
  ...openAICompatible("My Service", (ctx) => ({
    "Content-Type": "application/json",
    Authorization: "Bearer " + ctx.apiKey,
    ...ctx.headers
  }))
} as BackendDef
```

That is all `openrouter`, `groq` and `custom` are.

**If your service can also read text aloud** through OpenAI's `/audio/speech`
shape, give the entry a `speech` block: `source` (where its speech models and
voices are listed — `catalogue`, `fixed` or `typed`), `defaultModel`,
`defaultVoice`, `maxChars` (the provider's own per-request limit, not a
preference), and `synthesize: openAISpeech(label, headers, "mp3")`. Nothing
else needs to change: the Listen button, Settings → Listening and the usage
ledger all read it from there. A backend with no `speech` block is simply never
offered as a voice.

### What a good backend PR includes

- The `BACKENDS` entry and the `BACKEND_ORDER` line.
- **Error messages that name the fix.** Use `httpError` and `reachError`; add a
  case if your service fails in a way those do not describe well. The Ollama
  adapter is the example to follow — a network failure there tells you about
  `OLLAMA_ORIGINS`, because that is what is actually wrong nine times in ten.
- A short setup section in `README.md`, matching the shape of the existing ones,
  including a `config.local.json` snippet.
- Confirmation in the PR description that you ran **Test**, **Load model list**,
  card generation, a streamed chat conversation, pressing **Stop** mid-stream,
  and recall marking against it. Those exercise everything: non-streaming, model
  listing, JSON parsing, streaming, cancellation, and low-temperature structured
  output.

### Streaming

Chat and the drill tutor stream; card writing and marking do not. Two readers
are provided: `readSSE` for `data:`-framed streams (OpenAI-compatible and
Anthropic) and `readNDJSON` for newline-delimited JSON (Ollama). Most services
need neither written from scratch.

Cancellation matters more than it looks. When the user presses Stop, whatever
already streamed is **kept** as the reply rather than discarded — half an
explanation is still worth reading. That only works if your adapter lets the
`AbortError` propagate unchanged instead of wrapping it in a friendlier error.

## Contributing a deck

Decks go in `public/decks/examples/`. See
[public/decks/README.md](public/decks/README.md) for the format and the house
style — the style rules are not decoration, they are the difference between a
card you keep and a card you delete in a month.

1. Write the deck as `public/decks/examples/your-deck.json`.
2. Run `npm run deck:index` and add a one-line description to the entry it
   creates in `index.json`.
3. Import it into Drill and **actually drill twenty cards**. Cards that read
   fine and recall badly are the normal failure, and you only find them this way.

Keep it under a few hundred cards, and keep tags meaningful — interleaving works
by keeping consecutive cards from *different* tags, so a deck where everything
is tagged "General" cannot be interleaved.

`public/decks/examples/ml-course1.json` is **generated** from `src/lib/seed.ts`
(the copy Drill embeds so a first run needs no network round trip). Edit the
seed, then run `npm run seed:json`. Do not edit that JSON directly.

## Reporting a bug

Include:

- What you did, what happened, what you expected.
- Backend and model.
- Browser and whether you were on `npm run dev` or the built/deployed app.
- Anything in the browser console.
- **For a card that renders or schedules wrongly, paste the card JSON.** Copy it
  out of **Settings → Data → Export a piece → This deck**.

For a scheduling bug, also include the card's `srs` row from **Every deck, with
progress** on the same page — `S`, `D`, `reps`, `lapses` and `due` are what make
it reproducible.

Please strip your API key out of anything you paste. It is in `settings.key` of
a full backup.

## Scheduling changes

`src/lib/fsrs.ts` is pure and deliberately isolated: no DOM, no storage, no
globals read. Everything is passed in as a `params` object and returned as a
new state. That is what makes it possible to check a scheduling change without
a browser:

```bash
npx tsx -e "
  import('./src/lib/fsrs.ts').then((F) => {
    const p = F.normParams({ retention: 0.9 });
    let s = F.blankState('x'), now = Date.now();
    for (let i = 0; i < 5; i++) {
      s = F.review(s, 3, p, { now, noFuzz: true });
      console.log(s.state, s.S.toFixed(2), new Date(s.due).toISOString());
      now = s.due;
    }
  });
"
```

The FSRS-6 weights are **pinned** to the reference release so that everyone's
scheduling matches out of the box. Please do not change the defaults — users who
have optimised their own set against their review log can override them with
`fsrs.weights` in `config.local.json` (21 numbers; anything else falls back to
the defaults). If you have a case for changing the pinned values, open an issue
before a PR.

## Things that are deliberately not here

Not because they are bad ideas — because they cost something the project is not
willing to spend.

- **Cloud sync (Gist, Dropbox, a backend).** Would mean an account, a token with
  write scope, or a server. JSON import/export covers backup and moving between
  machines, and it cannot leak. Open an issue if you want to argue for it.
- **A card marketplace, streaks-as-gamification, notifications.** The insight
  log and the leech repair flow are the two features that change how you study.
  Everything else is decoration on top of a review queue.
- **A generic chat client.** The chat half exists because it can see your decks
  and write cards back into them. A feature that would be equally at home in any
  chat UI is a feature better used in one — the bar for adding to `components/chat`
  is that it connects the two halves of the app.
