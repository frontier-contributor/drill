/* ============================================================================
 * generated.ts — a picture the model drew, put where pictures go.
 *
 * It arrives as a `data:` URL on the reply and must not stay one. A
 * conversation is a single IndexedDB record rewritten whole on every message,
 * so a megabyte of base64 inside a variant would be re-serialised on every
 * message after it for the life of the thread — the reason the `Attachment`
 * type has said "never inline here" since files landed.
 *
 * So it goes through the same door an attached photograph does: `prepareImage`
 * for the dimensions and the thumbnail, `files.put` for the bytes, through the
 * write guard. What comes back is a reference small enough to live on a
 * variant. The only thing that stays inline is the 112px thumbnail, and that
 * is deliberate — it is what lets a list draw the picture before IndexedDB has
 * answered.
 *
 * A write that does not land returns nothing for that picture rather than a
 * record pointing at bytes that were never written. `files.put` has already
 * raised the save alarm by then; a dangling reference would be a second,
 * quieter failure on top of it.
 * ========================================================================== */
import * as U from "@/lib/util";
import { base64ToBlob } from "./bytes";
import * as files from "./db";
import type { GeneratedImage } from "@/types/chat";

/** `data:image/png;base64,iVBOR…` — mime and payload, or null for anything
 *  that is not one. The backend only hands over `data:image/`, so this is a
 *  second check rather than the only one. */
function parseDataUrl(url: string): { mime: string; data: string } | null {
  const m = /^data:([a-z0-9.+/-]+);base64,(.+)$/i.exec(url);
  if (!m || !m[1].startsWith("image/")) return null;
  return { mime: m[1], data: m[2] };
}

/**
 * Keep every picture a reply came back with.
 *
 * `prompt` is the message that asked for them, kept on each one so a picture
 * has a name without anyone having to invent one — it is what the Keep button
 * titles a kept picture with.
 */
export async function keepGenerated(dataUrls: readonly string[], prompt: string): Promise<GeneratedImage[]> {
  if (!dataUrls.length) return [];
  const { prepareImage } = await import("./image");
  const out: GeneratedImage[] = [];

  for (const url of dataUrls) {
    const parsed = parseDataUrl(url);
    if (!parsed) continue;
    try {
      const blob = base64ToBlob(parsed.data, parsed.mime);
      const name = `generated-${U.uid("")}.${parsed.mime.split("/")[1] || "png"}`;
      /* The same preparation an attached photograph gets: shrunk to the long
         edge everything else is sent at, re-encoded, thumbnailed. A generated
         picture is usually already inside that, so this mostly just measures
         it and draws the thumbnail. */
      const img = await prepareImage(new File([blob], name, { type: parsed.mime }), parsed.mime);
      const id = U.uuid();
      const ok = await files.put({
        id,
        name,
        mime: img.mime,
        size: img.blob.size,
        created: Date.now(),
        blob: img.blob
      });
      if (!ok) continue; // the save alarm has already said so
      out.push({
        id,
        fileId: id,
        mime: img.mime,
        w: img.w,
        h: img.h,
        size: img.blob.size,
        thumb: img.thumb,
        prompt: prompt.slice(0, 300),
        createdAt: Date.now()
      });
    } catch {
      /* One picture that will not decode must not lose the other two, or the
         reply that came with them. */
    }
  }
  return out;
}
