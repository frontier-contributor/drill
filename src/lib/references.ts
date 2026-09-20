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
 * A reference resolves to an Attachment, which is the mechanism the composer
 * already had for dropped files — so a referenced journal entry and a dropped
 * .md file travel the same path and are rendered the same way in the turn.
 *
 * `text` is a thunk. The catalogue is built on every keystroke while the
 * picker is open, and rendering every journal entry and every card each time
 * would be absurd; only the one you choose is ever materialised.
 * ========================================================================== */
import * as store from "@/services/store";
import * as journalStore from "@/services/journalStore";
import * as memoryStore from "@/services/memoryStore";
import * as figures from "@/services/figures";
import * as U from "@/lib/util";
import { renderToday } from "@/lib/dayBrief";
import { visualDef } from "@/lib/visuals/catalogue";
import type { Attachment } from "@/types/chat";

export type ReferenceKind = "today" | "figure" | "journal" | "book" | "deck" | "card" | "memory" | "note";

export interface Reference {
  id: string;
  kind: ReferenceKind;
  /** What goes in the chip, and what the "@" token in the box reads as. */
  label: string;
  /** The quiet second line in the picker. */
  hint: string;
  /** Materialise it. Called once, when the reference is actually chosen. */
  text: () => string;
}

/** The word shown on the chip before the label, so a glance says what kind of
 *  thing was attached without reading it. */
export const KIND_LABEL: Record<ReferenceKind, string> = {
  today: "today",
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

/**
 * Everything referenceable in this project, most immediate first.
 *
 * Order is the ranking: today, then what you wrote most recently, then the
 * reference shelf, then the material. Nothing here is filtered by the query —
 * the caller does that, so the same catalogue can back a picker, a palette or
 * a test.
 */
export function catalogue(projectId: string): Reference[] {
  const db = store.get();
  const out: Reference[] = [];

  /* --- the day itself --- */
  out.push({
    id: "today",
    kind: "today",
    label: "Today",
    hint: "everything you did today — reviews, attempts, what you wrote",
    text: () => renderToday(projectId, 1) || "Nothing recorded today yet."
  });

  /* --- figures you kept, with their block ---
     The other half of the `{kind:"figures"}` context source, and the reason
     that one is only a list of titles: this is where a figure is actually
     handed over, one at a time, when it is the thing being talked about.
     Sending the fence rather than a description means the model can revise it
     — and a revision written under the same title becomes the next version of
     what is already on the shelf rather than a second copy of it. */
  for (const f of figures.list(projectId).slice(0, 40)) {
    const def = visualDef(f.kind);
    out.push({
      id: "figure:" + f.id,
      kind: "figure",
      label: clip(f.title, 44),
      hint: `${def.label.toLowerCase()} · kept ${U.ago(f.updated)}${f.versions.length ? ` · v${f.versions.length + 1}` : ""}`,
      text: () =>
        `A figure the learner kept, titled "${f.title}" (${def.label.toLowerCase()})` +
        (f.note ? `. Their note on why: ${f.note}` : "") +
        ".\n\n```" +
        (f.info || def.fences[0]) +
        "\n" +
        f.source.replace(/\n$/, "") +
        "\n```\n\nTo revise it, write the whole block again under the same title."
    });
  }

  /* --- journal entries, newest first --- */
  for (const e of journalStore.listForProject(projectId).slice(0, 40)) {
    const preview = e.summary?.narrative || (e.raw[0]?.text ?? "");
    out.push({
      id: "journal:" + e.id,
      kind: "journal",
      label: e.day,
      hint: preview ? clip(preview, 80) : "empty entry",
      text: () => {
        const s = e.summary;
        if (!s) {
          return `Journal, ${e.day} (not written up yet). Raw notes:\n` + e.raw.map((r) => `- ${r.text}`).join("\n");
        }
        const bits = [s.narrative];
        if (s.did.length) bits.push("Did: " + s.did.join("; "));
        if (s.learned.length) bits.push("Learned: " + s.learned.join("; "));
        if (s.stuck.length) bits.push("Stuck on: " + s.stuck.join("; "));
        if (s.open.length) bits.push("Left open: " + s.open.join("; "));
        if (s.nextUp.length) bits.push("Next up: " + s.nextUp.join("; "));
        return `Journal, ${e.day}:\n` + bits.filter(Boolean).join("\n");
      }
    });
  }

  /* --- the project's shelf: files and text pinned to the project --- */
  for (const k of db.projects[projectId]?.knowledge || []) {
    out.push({
      id: "book:" + k.id,
      kind: "book",
      label: k.name,
      hint: `${k.kind} · ${k.text.length.toLocaleString()} chars${k.enabled ? "" : " · off by default"}`,
      text: () => `From "${k.name}":\n${k.text}`
    });
  }

  /* --- decks, as whole objects --- */
  const decks = store.decksOf(projectId);
  for (const d of decks) {
    const seen = d.cards.filter((c) => d.srs[c.id]?.reps).length;
    out.push({
      id: "deck:" + d.id,
      kind: "deck",
      label: d.name,
      hint: `${d.cards.length} cards · ${seen} seen`,
      text: () =>
        `The deck "${d.name}" (${d.cards.length} cards):\n` +
        d.cards.map((c) => `- (${c.tag}) ${U.stripTags(c.q)} => ${U.stripTags(c.a)}`).join("\n")
    });
  }

  /* --- memories --- */
  for (const m of memoryStore.list({ scope: "project", projectId, activeOnly: true }).slice(0, 40)) {
    out.push({
      id: "memory:" + m.id,
      kind: "memory",
      label: clip(m.text, 44),
      hint: `${m.type} · ${U.ago(m.updatedAt)}`,
      text: () => `A memory held about this learner (${m.type}): ${m.text}`
    });
  }

  /* --- the insight log --- */
  for (const n of (db.notes || []).filter((x) => x.projectId === projectId).slice(-30).reverse()) {
    out.push({
      id: "note:" + n.id,
      kind: "note",
      label: clip(n.text, 44),
      hint: `note · ${U.ago(n.t)}`,
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
        hint: `card · ${c.tag} · ${d.name}`,
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
 *  pressing enter attaches today. */
export function search(refs: Reference[], query: string, limit = 8): Reference[] {
  const q = query.trim().toLowerCase();
  if (!q) return refs.slice(0, limit);
  const scored: { r: Reference; s: number }[] = [];
  for (const r of refs) {
    const label = r.label.toLowerCase();
    const s = label.startsWith(q) ? 3 : label.includes(q) ? 2 : r.hint.toLowerCase().includes(q) ? 1 : 0;
    if (s) scored.push({ r, s });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map((x) => x.r);
}

/** Materialise a reference into the attachment that will ride along with the
 *  message. `size` is characters, matching how pasted selections are counted. */
export function toAttachment(r: Reference): Attachment {
  const text = r.text();
  return {
    id: U.uid("a"),
    name: `${KIND_LABEL[r.kind]}: ${r.label}`,
    kind: r.kind === "card" ? "card" : r.kind === "note" ? "note" : r.kind === "deck" ? "deck" : "selection",
    size: text.length,
    text
  };
}
