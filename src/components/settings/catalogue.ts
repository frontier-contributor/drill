/* ============================================================================
 * catalogue.ts — every settings page and every group on it, declared once.
 *
 * There were four copies of the category list inside SettingsHome before the
 * settings rework, and getting three of the four right gave you a page that
 * was unreachable or unlabelled. That collapsed to one list in registry.tsx.
 * This file is the same lesson applied one level down: the *sections* inside a
 * page were spelled out in the component that rendered them, and the words you
 * would search for were spelled out again as a bag of `keywords` on the
 * category — two places, no link between them, and no way to tell that
 * "retention" had stopped matching anything real.
 *
 * So the title, the sentence under it, and the words someone would type to
 * find it live here, together, once. `Section` renders from this record;
 * search reads the same record. A control you add is findable when you add its
 * word to `finds` beside the section it is on, and there is nowhere else to
 * put it.
 *
 * Pure data on purpose — no React, no store — so `catalogue.test.ts` can hold
 * it to its promises without a DOM.
 * ========================================================================== */

export type CatId =
  | "conversation"
  | "connection"
  | "chat"
  | "listening"
  | "memory"
  | "review"
  | "appearance"
  | "project"
  | "usage"
  | "data";

/* The rail is grouped because nine flat names is a list you read rather than
   scan. The groups answer "whose setting is this": the thread in front of
   you, the assistant in general, the studying, or this browser. */
export type GroupId = "here" | "assistant" | "work" | "browser";

export const GROUPS: { id: GroupId; label: string }[] = [
  { id: "here", label: "Right here" },
  { id: "assistant", label: "The assistant" },
  { id: "work", label: "Your work" },
  { id: "browser", label: "This browser" }
];

export interface CategoryMeta {
  id: CatId;
  /** The name in the rail. The project page overrides this at render time,
   *  because the space that is not a project is called Personal. */
  label: string;
  /** The sentence under the name in search results. */
  blurb: string;
  group: GroupId;
  /** A page whose content needs a context only one view mounts. The
   *  conversation page reads ChatProvider, so it is offered in chat and
   *  nowhere else rather than offered everywhere and empty in five views. */
  needs?: "conversation";
}

/* Order is the order of the rail, and it is the order the questions get
   asked: the thread you are in, then what answers it, then what you are
   studying, then the machine it all sits on. */
export const CATEGORY_META: CategoryMeta[] = [
  {
    id: "conversation",
    label: "This chat",
    blurb: "Model, persona, sampling and what this one thread can see.",
    group: "here",
    needs: "conversation"
  },
  {
    id: "connection",
    label: "Connection",
    blurb: "Where inference runs, and the credential to get there.",
    group: "assistant"
  },
  {
    id: "chat",
    label: "Chat",
    blurb: "What every new conversation starts from, and what it spends.",
    group: "assistant"
  },
  {
    id: "listening",
    label: "Listening",
    blurb: "Replies read aloud: the voice, the speed, and the audio it keeps.",
    group: "assistant"
  },
  {
    id: "memory",
    label: "Memory",
    blurb: "What the assistant is allowed to remember, and everything it already has.",
    group: "assistant"
  },
  {
    id: "review",
    label: "Review",
    blurb: "What you drill, how much of it, how often it comes back, and who marks it.",
    group: "work"
  },
  {
    id: "project",
    label: "Project",
    blurb: "This space's name, goals, its defaults, its memory policy and its decks.",
    group: "work"
  },
  {
    id: "appearance",
    label: "Appearance",
    blurb: "Night or day, the accent, density and reading size.",
    group: "browser"
  },
  {
    id: "usage",
    label: "Usage",
    blurb: "What every call has cost, and exactly what each one sent.",
    group: "browser"
  },
  {
    id: "data",
    label: "Data",
    blurb: "Back up, restore, import and export everything this browser holds.",
    group: "browser"
  }
];

export interface SectionMeta {
  cat: CatId;
  title: string;
  sub: string;
  /** What someone would type looking for a control in this group. Add to it
   *  whenever you add a control: search is the only defence against a setting
   *  that exists and cannot be found, and this app has already lost backup and
   *  restore to a menu nobody thought to look in. */
  finds: string[];
}

/** Identity, typed so a mistyped `id` on a `<Section>` is a compile error
 *  rather than a section that silently loses its heading. */
function sections<T extends Record<string, SectionMeta>>(s: T): T {
  return s;
}

/* Declared in the order they are rendered, because that is also the order
   search lists them in — a page's entries read as its table of contents. */
export const SECTIONS = sections({
  /* ---------------------------------------------------- this conversation -- */
  "conversation.persona": {
    cat: "conversation",
    title: "How it answers",
    sub: "The persona sets the system prompt. Custom instructions replace it outright.",
    finds: ["persona", "mode", "system prompt", "custom instructions", "tutor", "socratic", "explainer", "feynman", "researcher", "plain"]
  },
  "conversation.model": {
    cat: "conversation",
    title: "Model for this thread",
    sub: "Conversation beats project beats global — the badge on each row says which level is in force.",
    finds: ["model", "backend", "provider", "effort", "price", "cost", "context length", "override", "inherit"]
  },
  "conversation.sampling": {
    cat: "conversation",
    title: "Sampling",
    sub: "How literal the model is, and how long it is allowed to run on.",
    finds: ["temperature", "sampling", "reply limit", "max tokens", "length", "creativity"]
  },
  "conversation.context": {
    cat: "conversation",
    title: "What it can see",
    sub: "Rebuilt from your decks and memory every time you send, so it always reflects today's progress rather than the day the thread started.",
    finds: ["context", "attach", "deck", "today", "weak spots", "due", "insight log", "notes", "memory", "project files", "knowledge", "journal"]
  },

  /* -------------------------------------------------------------- connection -- */
  "connection.provider": {
    cat: "connection",
    title: "Provider and credential",
    sub: "Every request goes straight from this browser to the provider you pick — there is no server in between, which is why the key lives here and not in an account.",
    finds: ["api key", "key", "token", "credential", "secret", "openrouter", "groq", "ollama", "openai", "compatible", "backend", "provider", "base url", "endpoint", "local", "config", "test connection"]
  },
  "connection.model": {
    cat: "connection",
    title: "Default model",
    sub: "The bottom of the chain: a project or a conversation that has not pinned one falls through to this.",
    finds: ["default model", "model", "fallback", "gpt", "claude", "llama", "deepseek"]
  },

  /* -------------------------------------------------------------------- chat -- */
  "chat.effort": {
    cat: "chat",
    title: "Effort",
    sub: "How hard a new conversation tries by default. Any thread can override it from the composer.",
    finds: ["effort", "reasoning", "thinking", "depth", "low", "medium", "high", "budget", "lookups", "agent"]
  },
  "chat.requests": {
    cat: "chat",
    title: "Extra requests per message",
    sub: "Both of these buy convenience with a second call. They are listed together because that is the only thing they have in common, and it is the thing that costs money.",
    finds: ["follow-ups", "followups", "suggestions", "suggested questions", "auto title", "naming", "titles", "cost", "extra calls"]
  },
  "chat.files": {
    cat: "chat",
    title: "Files you attach",
    sub: "Pictures go to a model that can see; everything else is read in this browser first, so the model gets text it can quote. Where a PDF is read is the one choice.",
    finds: [
      "files", "attach", "attachments", "upload", "pdf", "ocr", "scanned", "scan", "images", "pictures", "photos",
      "screenshots", "vision", "word", "docx", "excel", "xlsx", "csv", "spreadsheet", "mistral", "cloudflare", "parser"
    ]
  },
  "chat.figures": {
    cat: "chat",
    title: "Figures in replies",
    sub: "Diagrams, charts, function plots, drawings and small interactive pages. The model writes them as text and they are drawn here, so they cost no extra request and work on every backend.",
    finds: [
      "figures", "diagram", "diagrams", "mermaid", "flowchart", "sequence", "mind map", "charts", "graphs", "plot",
      "plots", "vega", "vega-lite", "function plot", "sliders", "svg", "drawings", "visuals", "visualisation",
      "visualization", "pictures", "canvas", "interactive", "simulation", "animation", "widget", "sandbox", "html",
      "artifact", "artifacts"
    ]
  },

  /* --------------------------------------------------------------- listening -- */
  "listening.voice": {
    cat: "listening",
    title: "Voice",
    sub: "Who reads replies aloud. Only voices that can actually speak from here are offered — a hosted one needs its key on the Connection page.",
    finds: [
      "voice", "voices", "read aloud", "listen", "listening", "text to speech", "tts", "speech", "narrator", "audio",
      "kokoro", "openrouter voice", "groq voice", "device voice", "browser voice", "speech model", "sample", "preview"
    ]
  },
  "listening.playback": {
    cat: "listening",
    title: "Playback",
    sub: "How fast it reads, and whether the page follows along.",
    finds: ["speed", "rate", "faster", "slower", "playback", "follow along", "highlight", "auto-scroll", "karaoke"]
  },
  "listening.audio": {
    cat: "listening",
    title: "Saved audio",
    sub: "Clips already heard are kept so a replay is instant and free — capped, and never at the expense of your own data.",
    finds: ["saved audio", "audio cache", "cache", "disk", "clear audio", "replay", "offline", "storage used"]
  },

  /* ------------------------------------------------------------------ memory -- */
  "memory.policy": {
    cat: "memory",
    title: "What may be remembered",
    sub: "How freely the assistant may write memory without being asked. A project can be stricter than this, never looser.",
    finds: ["autonomy", "manual", "assisted", "auto", "permission", "consent", "policy", "remember", "privacy"]
  },
  "memory.pending": {
    cat: "memory",
    title: "Waiting for you",
    sub: "Nothing here is memory until you accept it. Distilling a journal entry proposes into this tray.",
    finds: ["tray", "pending", "candidates", "proposed", "accept", "reject", "distill", "review memory"]
  },
  "memory.store": {
    cat: "memory",
    title: "What it knows",
    sub: "Everything remembered about you and this project — editable, pinnable, and retirable one at a time.",
    finds: ["memories", "facts", "what it knows", "pin", "unpin", "retire", "restore", "consolidate", "tidy", "global", "project", "profile", "preference", "goal", "convention", "understanding", "forget", "delete memory"]
  },

  /* ------------------------------------------------------------------ review -- */
  "review.queue": {
    cat: "review",
    title: "The queue",
    sub: "Which cards the review loop serves. Every project keeps its own decks, so this never reaches outside the space you are in.",
    finds: ["deck", "decks", "active deck", "switch deck", "mix", "mixing", "interleaving", "all decks", "which cards", "queue"]
  },
  "review.run": {
    cat: "review",
    title: "The day's run",
    sub: "The queue is endless by design, which is correct for scheduling and hopeless as a thing to sit down to. A run puts a finish line somewhere.",
    finds: ["session", "session size", "run", "finish line", "how many cards", "daily target", "goal", "stop"]
  },
  "review.scheduling": {
    cat: "review",
    title: "Scheduling",
    sub: "How much comes back, and how soon. These feed FSRS directly.",
    finds: ["fsrs", "retention", "target retention", "scheduling", "spaced repetition", "new cards per day", "new per day", "interval", "longest interval", "maximum interval", "intervals"]
  },
  "review.answering": {
    cat: "review",
    title: "Answering",
    sub: "What happens between seeing a question and grading yourself on it.",
    finds: ["recall", "write it", "free recall", "flip", "reveal", "marking", "ai marks", "grade", "interleave", "sections", "blocking"]
  },
  "review.tutor": {
    cat: "review",
    title: "The tutor",
    sub: "Who is marking your answers, and in what language.",
    finds: ["tutor", "tutor style", "marking prompt", "language", "english", "hinglish", "voice", "tone"]
  },

  /* ----------------------------------------------------------------- project -- */
  "project.identity": {
    cat: "project",
    title: "This project",
    sub: "The name in the switcher, and the one line of purpose that rides on every chat turn started here.",
    finds: ["project", "space", "personal", "name", "rename", "blurb", "goals", "purpose", "standing instruction", "about me"]
  },
  "project.defaults": {
    cat: "project",
    title: "Defaults here",
    sub: "What a new conversation in this space starts from. Blank falls through to the global setting; a thread can override either.",
    finds: ["defaults", "backend", "model", "persona", "effort", "inherit", "project model"]
  },
  "project.memory": {
    cat: "project",
    title: "Memory here",
    sub: "A space can be stricter than the global policy, never looser.",
    finds: ["memory policy", "autonomy", "injected", "budget", "max memories", "per turn", "project memory"]
  },
  "project.knowledge": {
    cat: "project",
    title: "Knowledge",
    sub: "Attached to every conversation here, on every message. Pay for it once and it is always in front of the model — which also means you pay for it on every message.",
    finds: ["knowledge", "files", "attach", "reference", "upload", "paste", "always attached", "documents"]
  },
  "project.decks": {
    cat: "project",
    title: "Decks",
    sub: "What this project owns. Everything that makes, renames, empties or destroys a deck is here; which one you are drilling is a Review setting.",
    finds: ["decks", "new deck", "add deck", "rename deck", "delete deck", "remove deck", "move deck", "reset progress", "clear progress", "start over", "cards"]
  },

  /* -------------------------------------------------------------- appearance -- */
  "appearance.printing": {
    cat: "appearance",
    title: "Printing",
    sub: "Night is warm dark for evening sessions; Day is warm paper. Same design, same type — only the ink and the paper swap.",
    finds: ["theme", "dark", "light", "night", "day", "printing", "colour", "color", "accent", "ink", "paper"]
  },
  "appearance.density": {
    cat: "appearance",
    title: "Density and reading size",
    sub: "Density trims the chrome; reading size scales card, journal and chat text only.",
    finds: ["density", "compact", "comfortable", "spacing", "font size", "text size", "reading size", "zoom", "bigger text", "smaller"]
  },

  /* ------------------------------------------------------------------- usage -- */
  "usage.cost": {
    cat: "usage",
    title: "What this has cost",
    sub: "Every call the app makes, not just chat — cards, journal, distill, exam and listening go through the same two seams and are counted here.",
    finds: ["usage", "cost", "spend", "money", "price", "tokens", "characters", "billing", "history", "ledger", "expensive", "clear history"]
  },
  "usage.transcript": {
    cat: "usage",
    title: "Run transcript",
    sub: "What every call actually sent and got back, this session. The debugging tool for journal, distill, exam and chat alike, and the honest answer to “what is it doing”.",
    finds: ["transcript", "debug", "raw", "request", "response", "prompt", "what did it send", "log", "trace", "failed", "error"]
  },

  /* -------------------------------------------------------------------- data -- */
  "data.storage": {
    cat: "data",
    title: "Your data",
    sub: "All of it lives in this browser. No account, no server, nothing uploaded — which is the point, and also the risk.",
    finds: [
      "storage", "quota", "disk", "full", "persistent", "persistence", "eviction", "evicted", "lost", "data loss",
      "disappeared", "gone", "wiped", "cleared", "safe", "keep my data", "how much", "size", "origin", "port",
      "incognito", "private window", "save failed", "cannot save"
    ]
  },
  "data.files": {
    cat: "data",
    title: "Attached files",
    sub: "Pictures and PDFs you attach are kept in this browser beside the conversations that use them — only their text lives inside the chat itself.",
    finds: ["attached files", "attachments", "uploads", "pictures", "images", "pdf", "unused", "clean up", "free space", "disk"]
  },
  "data.backup": {
    cat: "data",
    title: "Back up and restore",
    sub: "One file with everything in it: decks, scheduling, chats, journal, memory and usage. This is how Drill moves to another browser, another machine, or back from a browser that cleared its storage.",
    finds: ["backup", "back up", "restore", "recover", "recovery", "snapshot", "another browser", "another machine", "json", "everything"]
  },
  "data.export": {
    cat: "data",
    title: "Export a piece",
    sub: "Readable, shareable files. None of these carries your chats, your memory or your review history — that is what the full backup above is for.",
    finds: ["export", "download", "share", "deck file", "markdown", "insight log", "notes", "save out"]
  },
  "data.import": {
    cat: "data",
    title: "Import cards",
    sub: "A deck file, or a bare list of cards. Nothing else in the app is touched.",
    finds: ["import", "upload", "paste cards", "json", "validate", "add cards", "load deck"]
  },
  "data.examples": {
    cat: "data",
    title: "Example decks",
    sub: "The decks that ship with Drill. Each one is added as a new deck in this project.",
    finds: ["examples", "example decks", "sample", "starter", "seed", "try it", "demo"]
  }
});

export type SectionId = keyof typeof SECTIONS & string;

/** Declaration order, which is render order — string keys keep insertion
 *  order, so the two cannot drift. */
export const SECTION_IDS = Object.keys(SECTIONS) as SectionId[];

export function sectionsOf(cat: CatId): SectionId[] {
  return SECTION_IDS.filter((id) => SECTIONS[id].cat === cat);
}

export function categoryMeta(id: CatId): CategoryMeta {
  const m = CATEGORY_META.find((c) => c.id === id);
  if (!m) throw new Error("unknown settings category: " + id);
  return m;
}

/** Everything a search could reasonably match this section on — its own words
 *  plus its page's, so typing a page's name lists that page's contents. */
function haystack(id: SectionId): string {
  const s = SECTIONS[id];
  const cat = categoryMeta(s.cat);
  return [cat.label, cat.blurb, s.title, s.sub, ...s.finds].join(" ").toLowerCase();
}

/** Substring, case-folded, every word required. Deliberately not fuzzy: a
 *  search that guesses is a search you stop trusting the moment it guesses
 *  wrong. */
export function sectionMatches(id: SectionId, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = haystack(id);
  return q.split(/\s+/).every((word) => hay.includes(word));
}

/** Matching sections, restricted to the pages this view can actually render.
 *
 *  A page's own name outranks a passing mention of it. Typing "review" is
 *  asking to browse the Review page, not to be handed every group whose blurb
 *  happens to use the word — "review before it changes memory" is a true match
 *  and a useless first result. Sort is stable, so declaration order (which is
 *  render order) survives inside each tier. */
export function search(query: string, available: CatId[]): SectionId[] {
  const allowed = new Set(available);
  const hits = SECTION_IDS.filter((id) => allowed.has(SECTIONS[id].cat) && sectionMatches(id, query));
  const q = query.trim().toLowerCase();
  if (!q) return hits;
  const named = (id: SectionId) => (categoryMeta(SECTIONS[id].cat).label.toLowerCase().includes(q) ? 0 : 1);
  return hits.sort((a, b) => named(a) - named(b));
}
