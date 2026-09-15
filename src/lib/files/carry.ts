/* ============================================================================
 * carry.ts — what each attachment sends, on each turn it is replayed.
 *
 * Text attachments have always been inlined into every message still inside
 * the history window. A picture cannot work that way: a photo is a thousand or
 * more tokens, and replaying it on every later turn of a long conversation pays
 * for it again every time, for a picture the model already described. So a
 * picture rides as itself only on the turn it was sent with and the one after
 * (one, at low effort), and as a line saying it was shown earlier after that —
 * unless it is pinned, which is the learner saying "keep this in front of it".
 *
 * PDFs follow the engine. Read locally, a PDF is its extracted text like any
 * other document, plus its scanned pages as pictures for a model that can see.
 * Sent to OpenRouter's parser, it goes as a file while fresh and falls back to
 * the locally extracted text once it is not — the text is already here, so an
 * old PDF is never re-parsed and never lost.
 *
 * Pure: services/files/parts.ts turns a decision into bytes.
 * ========================================================================== */
import type { Attachment } from "@/types/chat";
import type { PdfEngine } from "@/types";
import type { ModalityVerdict } from "@/lib/modality";

export interface CarryContext {
  /** User turns between this one and the newest: 0 for the message being sent. */
  age: number;
  /** How many of the newest user turns carry pictures and files as themselves. */
  window: number;
  image: ModalityVerdict;
  file: ModalityVerdict;
  backend: string;
  pdfEngine: PdfEngine;
}

export type Carry =
  | { as: "text"; text: string }
  | { as: "image"; text: string; fileIds: string[] }
  | { as: "file"; text: string; fileId: string; mime: string };

export function textBlock(a: Pick<Attachment, "name" | "text">): string {
  return `--- attached: ${a.name} ---\n${a.text}\n--- end ${a.name} ---`;
}

/** Low effort is one turn of pictures; anything else is two. */
export function windowFor(effort: string): number {
  return effort === "low" ? 1 : 2;
}

export function carry(a: Attachment, ctx: CarryContext, pinned = false): Carry {
  const fresh = pinned || ctx.age < ctx.window;

  if (a.kind === "image") {
    if (!a.fileId) return { as: "text", text: `[image "${a.name}" — its file is not in this browser]` };
    if (ctx.image === "no") {
      return { as: "text", text: `[image "${a.name}" attached — this model cannot see images, so only its name was sent]` };
    }
    if (!fresh) return { as: "text", text: `[image "${a.name}" was shown earlier in this conversation]` };
    return { as: "image", text: `[image "${a.name}"${a.dims ? ` · ${a.dims.w}×${a.dims.h}` : ""}]`, fileIds: [a.fileId] };
  }

  if (a.kind === "pdf") {
    const remote =
      ctx.pdfEngine !== "local" && ctx.backend === "openrouter" && !(ctx.pdfEngine === "native" && ctx.file === "no");
    if (remote && fresh && a.fileId) {
      return {
        as: "file",
        text: `[PDF "${a.name}"${a.pages ? `, ${a.pages} page${a.pages === 1 ? "" : "s"}` : ""} — attached as a file]`,
        fileId: a.fileId,
        mime: a.mime || "application/pdf"
      };
    }
    if (fresh && a.pageImages?.length && ctx.image !== "no") {
      const n = a.pageImages.length;
      return {
        as: "image",
        text: `${textBlock(a)}\n[${n} scanned page${n === 1 ? "" : "s"} of "${a.name}" attached as ${n === 1 ? "a picture" : "pictures"}]`,
        fileIds: a.pageImages
      };
    }
    return { as: "text", text: textBlock(a) };
  }

  return { as: "text", text: textBlock(a) };
}
