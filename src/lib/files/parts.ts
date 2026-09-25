/* ============================================================================
 * parts.ts — attachments as the rest of the app sees them: a line on the run
 * transcript, a card's subtitle, a token estimate, a set of file ids in use.
 *
 * Pure. The bytes themselves are services/files' business.
 * ========================================================================== */
import type { Attachment, Conversation } from "@/types/chat";
import type { ChatMessage, ContentPart } from "@/types";
import { estimateImageTokens, estimateTokens, formatTokens } from "@/lib/tokens";
import { size } from "./limits";

/** Decoded size of a base64 payload. */
export function partBytes(p: ContentPart): number {
  if (p.type === "text") return p.text.length;
  const pad = p.data.endsWith("==") ? 2 : p.data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((p.data.length * 3) / 4) - pad);
}

export function describePart(p: ContentPart): string {
  if (p.type === "text") return p.text;
  return `[${p.type === "image" ? "image" : "file"} ${p.name} · ${size(partBytes(p))}]`;
}

/**
 * Messages as the run transcript keeps them: every picture and file replaced by
 * a line naming it.
 *
 * The transcript holds two hundred calls in memory for the session. Three
 * screenshots a call in base64 would make it the largest thing in the tab, and
 * nobody debugging a prompt needs to read the pixels.
 */
export function forTranscript(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (!m.parts?.length) return m;
    const { parts, ...rest } = m;
    const lines = parts.filter((p) => p.type !== "text").map(describePart);
    return { ...rest, content: [m.content, ...lines].filter(Boolean).join("\n") };
  });
}

/**
 * Every file id a conversation still points at.
 *
 * Derived, never counted: a reference count is a second record that can
 * disagree with the first. Four places hold one — pinned attachments, an
 * attachment on a turn, a picture the model drew on a *variant*, and a figure
 * kept out of a reply.
 *
 * The third is the one that has to be remembered. `unusedFileIds` feeds a
 * button that deletes, and a holder this function does not walk is a file that
 * button silently throws away: a generated picture would survive until the
 * first time anyone pressed "Remove unused", and then not. `parts.test.ts`
 * pins exactly that.
 */
export function referencedFileIds(conversations: Pick<Conversation, "turns" | "pinnedAttachments">[]): Set<string> {
  const used = new Set<string>();
  const take = (a: Attachment) => {
    if (a.fileId) used.add(a.fileId);
    for (const id of a.pageImages || []) used.add(id);
  };
  for (const c of conversations) {
    for (const a of c.pinnedAttachments || []) take(a);
    for (const t of c.turns || []) {
      for (const a of t.attachments || []) take(a);
      /* Every variant, not just the active one: the others are one press of
         the variant arrow away and are still the learner's. */
      for (const v of t.variants || []) {
        for (const img of v.images || []) used.add(img.fileId);
        /* A clip is held the same way, and is the costliest file in the app
           to lose: it cannot be drawn again for the price of a picture. */
        for (const vid of v.videos || []) used.add(vid.fileId);
      }
    }
  }
  return used;
}

export function fileIdsOf(a: Attachment): string[] {
  return [...(a.fileId ? [a.fileId] : []), ...(a.pageImages || [])];
}

export function attachmentTokens(a: Attachment): number {
  return a.kind === "image" ? estimateImageTokens(a.dims) : estimateTokens(a.text);
}

const BADGE: Record<Attachment["kind"], string> = {
  file: "",
  selection: "TXT",
  card: "CARD",
  note: "NOTE",
  deck: "DECK",
  image: "IMG",
  pdf: "PDF",
  doc: "DOC",
  sheet: "XLS"
};

/** The short label on a card with no thumbnail. A text file shows its own
 *  extension, which says more than "FILE" does. */
export function kindBadge(a: Attachment): string {
  if (a.kind !== "file") return BADGE[a.kind];
  const m = /\.([a-z0-9]{1,5})$/i.exec(a.name);
  return m ? m[1].toUpperCase() : "TXT";
}

/** The card's second line: what it is, how big, and what it will cost to send. */
export function attachmentMeta(a: Attachment): string {
  const tok = `~${formatTokens(attachmentTokens(a))} tok`;
  const bits: string[] = [];
  if (a.kind === "image") {
    if (a.dims) bits.push(`${a.dims.w}×${a.dims.h}`);
  } else if (a.kind === "pdf") {
    if (a.pages) bits.push(`${a.pages} page${a.pages === 1 ? "" : "s"}`);
    if (a.scanned?.length) bits.push(`${a.scanned.length} scanned`);
  } else if (a.kind === "sheet") {
    if (a.pages) bits.push(`${a.pages} sheet${a.pages === 1 ? "" : "s"}`);
  } else if (a.kind === "doc") {
    bits.push("Word");
  } else if (a.kind === "file" && a.size) {
    bits.push(size(a.size));
  }
  bits.push(tok);
  if (a.truncated) bits.push("clipped");
  return bits.join(" · ");
}
