/* ============================================================================
 * drawing.ts — how a picture in Image mode gets drawn, and from what.
 *
 * Two routes, decided by what the model is rather than by anything the
 * learner has to know:
 *
 *   chat     chat/completions with the Image action — for the models that
 *            write as well as draw (Gemini's). They keep the conversation,
 *            and the reply can say something about the picture.
 *   images   OpenRouter's Images API — for the models that only draw (FLUX,
 *            Seedream, GPT-Image, Recraft…), which is most of them, and which
 *            the chat route was never going to reach well.
 *
 * The Images API is stateless, so a thread's continuity is carried by its
 * references: the picture you attached, and — while "build on the last
 * picture" is on — the one drawn last. The chat route gets the same last
 * picture back as an image on the newest message; before this, a thread that
 * said "now make the sky purple" sent the words and never the picture, so the
 * model drew a new one from nothing.
 * ========================================================================== */
import * as chatStore from "./chatStore";
import { catalogueEntry, imageCaps, loadImageCaps, loadPricing } from "./pricing";
import { fileIdsOf } from "@/lib/files/parts";
import type { ImageCaps } from "@/lib/mediaCaps";
import type { ImageSpec } from "@/lib/imageSpec";
import type { Conversation } from "@/types/chat";

export type DrawRoute = "chat" | "images";

/** Which route this model draws on. Waits for both listings, because the
 *  answer decides which endpoint is called and a guess is a failed picture. A
 *  model neither listing knows goes by chat — the route that at least answers
 *  in words when it cannot draw. */
export async function routeFor(model: string): Promise<DrawRoute> {
  await Promise.all([loadPricing(), loadImageCaps()]);
  const caps = imageCaps(model);
  if (caps) return caps.talks ? "chat" : "images";
  const kinds = catalogueEntry(model)?.kinds;
  if (kinds?.length && !kinds.includes("chat") && kinds.includes("image")) return "images";
  return "chat";
}

/** The file id of the last picture drawn in this thread before `before`,
 *  from each assistant turn's variant in view. */
export function lastPicture(c: Conversation, before: number): string | undefined {
  for (let i = Math.min(before, c.turns.length) - 1; i >= 0; i--) {
    const t = c.turns[i];
    if (t.role !== "assistant") continue;
    const v = t.variants[t.active];
    const img = v?.images?.[v.images.length - 1];
    if (img) return img.fileId;
  }
  return undefined;
}

/** The pictures on the message being answered. */
export function attachedPictures(c: Conversation, upTo: number): string[] {
  const asked = [...c.turns.slice(0, upTo + 1)].reverse().find((t) => t.role === "user");
  const out: string[] = [];
  for (const a of asked?.attachments || []) {
    if (a.kind !== "image") continue;
    const ids = fileIdsOf(a);
    if (ids[0]) out.push(ids[0]);
  }
  return out;
}

/** Whether "build on the last picture" is on for this spec. */
export function chaining(spec: ImageSpec | undefined): boolean {
  return spec?.chain !== false;
}

/**
 * The references to send with an Images API request: the last picture while
 * chaining, then whatever was attached — within what the model takes. A model
 * the listing says takes none is sent none; one the listing does not know is
 * sent them and left to say so.
 */
export function referencesFor(c: Conversation, upTo: number, spec: ImageSpec | undefined, caps: ImageCaps | undefined): string[] {
  if (caps && !caps.refs) return [];
  const ids: string[] = [];
  const last = chaining(spec) ? lastPicture(c, upTo) : undefined;
  if (last) ids.push(last);
  for (const id of attachedPictures(c, upTo)) if (!ids.includes(id)) ids.push(id);
  return caps?.refs ? ids.slice(0, caps.refs.max) : ids;
}

/** The prompt the picture is of: the message being answered. */
export function promptFor(c: Conversation, upTo: number): string {
  const asked = [...c.turns.slice(0, upTo + 1)].reverse().find((t) => t.role === "user");
  return asked ? chatStore.activeContent(asked) : c.title;
}
