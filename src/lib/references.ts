/* ============================================================================
 * references.ts — everything you can point at from inside a message.
 *
 * Conversation *context* (chatContext.ts) is standing policy: sources that go
 * out with every message in a thread, rebuilt at send time. This file is the
 * other half — pointing at one specific thing, once, in the middle of a
 * sentence. "@" the journal entry from Tuesday and ask about it.
 *
 * The distinction matters and the UI should keep it visible:
 *
 *   context     what this conversation can always see       every message
 *   reference   the thing you are talking about right now   this message
 *
 * And there is a third way in now, which is the one most people will use:
 * saying it. In Auto the assistant finds "the chat about attention" itself
 * (services/agent/tools.ts). "@" is for when you want to be sure which one —
 * the thing goes in with the message, so nothing has to be searched for and
 * the answer cannot be about the wrong one. The two reach the same places and
 * read them the same way: a chat or an exam is rendered by lib/digest.ts for
 * both, so an attached thread and a looked-up thread are one account of it.
 *
 * A reference resolves to an Attachment, which is the mechanism the composer
 * already had for dropped files — so a referenced journal entry and a dropped
 * .md file travel the same path and are rendered the same way in the turn.
 *
 * `text` is a thunk. The catalogue is built on every keystroke while the
 * picker is open, and rendering every journal entry and every card each time
 * would be absurd; only the one you choose is ever materialised. A past
 * conversation lives in IndexedDB, so its thunk returns a promise — the
 * composer shows it as a file being read until it lands.
 *
 * In the personal space the catalogue spans every project. It belongs to no
 * body of work, which is exactly why it is where you go to ask about all of
 * them; each line from elsewhere says which project it came from.
 * ========================================================================== */
import * as store from "@/services/store";
import * as journalStore from "@/services/journalStore";
import * as memoryStore from "@/services/memoryStore";
import * as figures from "@/services/figures";
import * as chatStore from "@/services/chatStore";
import * as examStore from "@/services/examStore";
import * as U from "@/lib/util";
import { renderToday } from "@/lib/dayBrief";
import { chatDigest, examDigest } from "@/lib/digest";
import { isPersonalProject } from "@/lib/migrate";
import { keptFence, keptLabel } from "@/lib/visuals/keep";
import type { Attachment } from "@/types/chat";
import type { Project } from "@/types";

export type ReferenceKind =
  | "today"
  | "chat"
  | "exam"
  | "project"
  | "figure"
  | "journal"
  | "book"
  | "deck"
  | "card"
  | "memory"
  | "note";

export interface Reference {
  id: string;
  kind: ReferenceKind;
  /** What goes in the chip, and what the "@" token in the box reads as. */
  label: string;
  /** The quiet second line in the picker. */
  hint: string;
  /** Materialise it. Called once, when the reference is actually chosen. */
  text: () => string | Promise<string>;
}

/** The word shown on the chip before the label, so a glance says what kind of
 *  thing was attached without reading it. */
export const KIND_LABEL: Record<ReferenceKind, string> = {
  today: "today",
  chat: "chat",
  exam: "exam",
  project: "project",
  figure: "figure",
  journal: "journal",
  book: "book",
  deck: "deck",
  card: "card",
  memory: "memory",
  note: "note"
};

function clip(s: string, n: number): string {
  const t = U.stripTags(s).replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

/** The bodies of work, oldest first — every project but the personal space
 *  and the archived ones, which the switcher hides too. */
function bodiesOfWork(): Project[] {
  return Object.values(store.projects())
    .filter((p) => !isPersonalProject(p.id) && !p.archived)
    .sort((a, b) => a.created - b.created);
}

/** A project in a paragraph: what it is for, what is in it, how it is going.
 *  What `@project` hands over — enough to talk about it, with the detail one
 *  lookup away in Auto. */
function projectBrief(p: Project): string {
  const decks = store.decksOf(p.id);
  const now = Date.now();
  let cards = 0;
  let due = 0;
  let failing = 0;
  for (const d of decks) {
    for (const c of d.cards) {
      cards++;
      const st = d.srs[c.id];
      if (st && st.reps) {
        if (st.due <= now) due++;
        if (store.isLeech(st)) failing++;
      }
    }
  }
  const days = journalStore
    .listForProject(p.id)
    .slice(0, 3)
    .map((e) => `- ${e.day}: ${clip(e.summary?.narrative || e.raw.map((r) => r.text).join(" ") || "empty", 200)}`);
  return [
    `The project "${p.name}"${p.blurb ? ` — ${p.blurb}` : ""}.`,
    p.goals ? `Their goal for it: ${p.goals}` : "No goal written for it yet.",
    `Decks: ${decks.map((d) => `${d.name} (${d.cards.length})`).join(", ") || "none"}. ${cards} cards, ${due} due now, ${failing} being failed.`,
    days.length ? "Latest journal:\n" + days.join("\n") : "No journal yet."
  ].join("\n");
}

/**
 * Everything referenceable from this space, most immediate first.
 *
 * Order is the ranking: today, the conversations you had most recently, then
 * what you wrote, the exams and projects, the reference shelf, then the
 * material. Nothing here is filtered by the query — the caller does that, so
 * the same catalogue can back a picker, a palette or a test.
 */
export function catalogue(projectId: string, opts: { conversationId?: string } = {}): Reference[] {
  const db = store.get();
  const out: Reference[] = [];
  const personal = isPersonalProject(projectId);
  /* Where to look: here, or — from the personal space — everywhere. */
  const ids = personal ? [projectId, ...bodiesOfWork().map((p) => p.id)] : [projectId];
  const name = (id: string) => db.projects[id]?.name || "a project";
  /** " · Project" on a line from somewhere other than here. */
  const elsewhere = (id: string | null | undefined) => (id && id !== projectId ? ` · ${name(id)}` : "");

  /* --- the day itself --- */
  out.push({
    id: "today",
    kind: "today",
    label: "Today",
    hint: personal ? "everything you did today, in every project" : "everything you did today — reviews, attempts, what you wrote",
    text: () => {
      if (!personal) return renderToday(projectId, 1) || "Nothing recorded today yet.";
      const days = ids
        .map((id) => ({ id, day: renderToday(id, 1) }))
        .filter((x) => x.day)
        .map((x) => (x.id === projectId ? x.day! : `In "${name(x.id)}":\n${x.day}`));
      return days.join("\n\n") || "Nothing recorded today yet.";
    }
  });

  /* --- the conversations you had, newest first ---
     The thread being written in is left out: it is already the history. */
  const scope = new Set(ids);
  for (const m of chatStore
    .list()
    .filter((x) => scope.has(x.projectId) && !x.archived && x.id !== opts.conversationId && x.turnCount > 0)
    .sort((a, b) => b.updated - a.updated)
    .slice(0, 30)) {
    out.push({
      id: "chat:" + m.id,
      kind: "chat",
      label: clip(m.title, 52),
      hint: `${m.turnCount} messages · ${U.ago(m.updated)}${elsewhere(m.projectId)}`,
      text: async () => {
        const c = await chatStore.load(m.id);
        if (!c) return `A past conversation titled "${m.title}" — it could not be read from this browser.`;
        return (
          "A past conversation the learner is pointing at:\n" +
          chatDigest(c, { where: m.projectId !== projectId && !isPersonalProject(m.projectId) ? name(m.projectId) : undefined })
        );
      }
    });
  }

  /* --- other projects, as wholes ---
     From the personal space, every one; from inside a project, the others —
     "how is this going compared with @[project: Linear algebra]". */
  for (const p of bodiesOfWork().filter((x) => x.id !== projectId)) {
    out.push({
      id: "project:" + p.id,
      kind: "project",
      label: p.name,
      hint: p.goals ? clip(p.goals, 80) : `${store.decksOf(p.id).length} decks`,
      text: () => projectBrief(p)
    });
  }

  /* --- exams, newest first --- */
  if (examStore.isLoaded()) {
    for (const e of ids
      .flatMap((id) => examStore.listForProject(id))
      .sort((a, b) => b.created - a.created)
      .slice(0, 20)) {
      const graded = e.questions.filter((q) => q.result);
      const got = graded.filter((q) => q.result!.verdict === "got").length;
      out.push({
        id: "exam:" + e.id,
        kind: "exam",
        label: clip(e.title, 52),
        hint: `${graded.length ? `${got}/${graded.length} got` : "not sat"} · ${U.ago(e.created)}${elsewhere(e.projectId)}`,
        text: () =>
          "An exam the learner sat, which they are pointing at:\n" +
          examDigest(e, { where: e.projectId !== projectId ? name(e.projectId) : undefined })
      });
    }
  }

  /* --- figures you kept, with their block ---
     The other half of the `{kind:"figures"}` context source, and the reason
     that one is only a list of titles: this is where a figure is actually
     handed over, one at a time, when it is the thing being talked about.
     Sending the fence rather than a description means the model can revise it
     — and a revision written under the same title becomes the next version of
     what is already on the shelf rather than a second copy of it. */
  for (const f of ids.flatMap((id) => figures.list(id)).slice(0, 40)) {
    const label = keptLabel(f.kind).toLowerCase();
    out.push({
      id: "figure:" + f.id,
      kind: "figure",
      label: clip(f.title, 44),
      hint: `${label} · kept ${U.ago(f.updated)}${f.versions.length ? ` · v${f.versions.length + 1}` : ""}${elsewhere(f.projectId)}`,
      /* A kept picture has no source to hand over — its bytes are in the file
         store, and this picker deals in text — so it goes as a line naming it
         and says where the picture itself can be got. Attaching the bytes is
         the paperclip's job, and it already knows whether the model can see. */
      text: () =>
        f.kind === "image"
          ? `A picture the learner generated and kept, titled "${f.title}"` +
            (f.note ? `. Their note on why: ${f.note}` : "") +
            ". They can attach the picture itself with the paperclip if you need to look at it."
          : `A figure the learner kept, titled "${f.title}" (${label})` +
            (f.note ? `. Their note on why: ${f.note}` : "") +
            ".\n\n```" +
            (f.info || keptFence(f.kind)) +
            "\n" +
            f.source.replace(/\n$/, "") +
            "\n```\n\nTo revise it, write the whole block again under the same title."
    });
  }

  /* --- journal entries, newest first --- */
  for (const e of ids.flatMap((id) => journalStore.listForProject(id).slice(0, personal ? 15 : 40))) {
    const preview = e.summary?.narrative || (e.raw[0]?.text ?? "");
    out.push({
      id: "journal:" + e.id,
      kind: "journal",
      label: e.day,
      hint: (preview ? clip(preview, 80) : "empty entry") + elsewhere(e.projectId),
      text: () => {
        const where = e.projectId !== projectId ? ` (${name(e.projectId)})` : "";
        const s = e.summary;
        if (!s) {
          return `Journal, ${e.day}${where} (not written up yet). Raw notes:\n` + e.raw.map((r) => `- ${r.text}`).join("\n");
        }
        const bits = [s.narrative];
        if (s.did.length) bits.push("Did: " + s.did.join("; "));
        if (s.learned.length) bits.push("Learned: " + s.learned.join("; "));
        if (s.stuck.length) bits.push("Stuck on: " + s.stuck.join("; "));
        if (s.open.length) bits.push("Left open: " + s.open.join("; "));
        if (s.nextUp.length) bits.push("Next up: " + s.nextUp.join("; "));
        return `Journal, ${e.day}${where}:\n` + bits.filter(Boolean).join("\n");
      }
    });
  }

  /* --- the shelf: files and text pinned to a project --- */
  for (const id of ids) {
    for (const k of db.projects[id]?.knowledge || []) {
      out.push({
        id: "book:" + k.id,
        kind: "book",
        label: k.name,
        hint: `${k.kind} · ${k.text.length.toLocaleString()} chars${k.enabled ? "" : " · off by default"}${elsewhere(id)}`,
        text: () => `From "${k.name}":\n${k.text}`
      });
    }
  }

  /* --- decks, as whole objects --- */
  const decks = ids.flatMap((id) => store.decksOf(id));
  for (const d of decks) {
    const seen = d.cards.filter((c) => d.srs[c.id]?.reps).length;
    out.push({
      id: "deck:" + d.id,
      kind: "deck",
      label: d.name,
      hint: `${d.cards.length} cards · ${seen} seen${elsewhere(d.projectId)}`,
      text: () =>
        `The deck "${d.name}" (${d.cards.length} cards):\n` +
        d.cards.map((c) => `- (${c.tag}) ${U.stripTags(c.q)} => ${U.stripTags(c.a)}`).join("\n")
    });
  }

  /* --- memories ---
     From the personal space, the global ones and every project's: what is
     known about you is not filed by where you happen to be asking. */
  const mems = personal
    ? memoryStore.list({ activeOnly: true })
    : memoryStore.list({ scope: "project", projectId, activeOnly: true });
  for (const m of mems.slice(0, 40)) {
    out.push({
      id: "memory:" + m.id,
      kind: "memory",
      label: clip(m.text, 44),
      hint: `${m.type} · ${U.ago(m.updatedAt)}${elsewhere(m.projectId)}`,
      text: () => `A memory held about this learner (${m.type}): ${m.text}`
    });
  }

  /* --- the insight log --- */
  for (const n of (db.notes || []).filter((x) => scope.has(x.projectId || "")).slice(-30).reverse()) {
    out.push({
      id: "note:" + n.id,
      kind: "note",
      label: clip(n.text, 44),
      hint: `note · ${U.ago(n.t)}${elsewhere(n.projectId)}`,
      text: () => `From their insight log (${U.ago(n.t)}): ${n.text}`
    });
  }

  /* --- individual cards, last because there are the most of them --- */
  for (const d of decks) {
    for (const c of d.cards) {
      out.push({
        id: "card:" + c.id,
        kind: "card",
        label: clip(c.q, 52),
        hint: `card · ${c.tag} · ${d.name}${elsewhere(d.projectId)}`,
        text: () => `A card from "${d.name}" (${c.tag}):\nFront: ${U.stripTags(c.q)}\nBack: ${U.stripTags(c.a)}`
      });
    }
  }

  return out;
}

/** Rank the catalogue against what has been typed after the "@".
 *
 *  A label match beats a hint match, and an empty query keeps catalogue order
 *  — which is already "most immediate first", so opening the picker and
 *  pressing enter attaches today. A query can also name a kind ("chat",
 *  "exam ") to list only that kind, which is how you browse a shelf you do not
 *  remember the contents of. */
export function search(refs: Reference[], query: string, limit = 8): Reference[] {
  const q = query.trim().toLowerCase();
  if (!q) return refs.slice(0, limit);
  const kind = (Object.keys(KIND_LABEL) as ReferenceKind[]).find((k) => q === k || q.startsWith(k + " "));
  const rest = kind ? q.slice(kind.length).trim() : q;
  const pool = kind ? refs.filter((r) => r.kind === kind) : refs;
  if (!rest) return pool.slice(0, limit);
  const scored: { r: Reference; s: number }[] = [];
  for (const r of pool) {
    const label = r.label.toLowerCase();
    const s = label.startsWith(rest) ? 3 : label.includes(rest) ? 2 : r.hint.toLowerCase().includes(rest) ? 1 : 0;
    if (s) scored.push({ r, s });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map((x) => x.r);
}

/** Materialise a reference into the attachment that will ride along with the
 *  message. `size` is characters, matching how pasted selections are counted.
 *  Async because a past conversation has to be read from IndexedDB. */
export async function toAttachment(r: Reference): Promise<Attachment> {
  const text = await r.text();
  return {
    id: U.uid("a"),
    name: `${KIND_LABEL[r.kind]}: ${r.label}`,
    kind: r.kind === "card" ? "card" : r.kind === "note" ? "note" : r.kind === "deck" ? "deck" : "selection",
    size: text.length,
    text
  };
}
