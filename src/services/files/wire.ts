/* ============================================================================
 * wire.ts — turning the decision about an attachment into bytes, at send time.
 *
 * lib/files/carry.ts decides what each attachment sends on each turn; this
 * reads the files it named out of drill-files and puts them on the message.
 * Kept apart from building the prompt because that also runs for follow-up
 * suggestions, which never carry a picture and should never wait on a disk.
 * ========================================================================== */
import * as files from "./db";
import { blobToBase64 } from "./bytes";
import type { ChatMessage, ContentPart } from "@/types";

export interface BinaryNeed {
  /** Index into the message list. */
  message: number;
  kind: "image" | "file";
  fileIds: string[];
  name: string;
  mime?: string;
}

export async function hydrate(messages: ChatMessage[], needs: BinaryNeed[]): Promise<ChatMessage[]> {
  if (!needs.length) return messages;
  const out = messages.map((m) => ({ ...m }));
  for (const need of needs) {
    const m = out[need.message];
    if (!m) continue;
    const added: ContentPart[] = [];
    let missing = 0;
    for (const id of need.fileIds) {
      const rec = await files.get(id);
      if (!rec) {
        missing++;
        continue;
      }
      const data = await blobToBase64(rec.blob);
      added.push(
        need.kind === "image"
          ? { type: "image", mime: rec.mime, data, name: rec.name }
          : { type: "file", mime: need.mime || rec.mime, data, name: rec.name }
      );
    }
    /* A file that is no longer here is said, not silently dropped: a model told
       nothing would answer about a picture it was never shown. */
    if (missing) {
      m.content += `\n[${need.name} — ${missing === need.fileIds.length ? "its file is" : "some of its pages are"} no longer in this browser]`;
    }
    const earlier = (m.parts || []).filter((p) => p.type !== "text");
    const all = [...earlier, ...added];
    m.parts = all.length ? [{ type: "text", text: m.content }, ...all] : undefined;
  }
  return out;
}

/** Stored files as data: URLs, for an endpoint that takes pictures by value —
 *  the Images API's references. A file that is no longer here is skipped: the
 *  picture is drawn without it rather than not at all. */
export async function dataUrlsOf(ids: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const id of ids) {
    const rec = await files.get(id);
    if (!rec) continue;
    out.push(`data:${rec.mime};base64,${await blobToBase64(rec.blob)}`);
  }
  return out;
}
