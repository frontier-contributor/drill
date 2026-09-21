/* ============================================================================
 * sweep.ts — which kept files nothing uses any more.
 *
 * A file is kept the moment it is attached, before anyone knows whether the
 * message will be sent; a conversation can be deleted with pictures in it. So
 * files can outlive what used them, and the answer to "which" is worked out
 * from every conversation rather than tracked with a count that could drift.
 * ========================================================================== */
import * as chatStore from "@/services/chatStore";
import { idbAll, STORE_CONV } from "@/services/idb";
import { referencedFileIds } from "@/lib/files/parts";
import * as files from "./db";
import type { Conversation } from "@/types/chat";

/** Anything attached in the last hour is left alone: it may belong to a message
 *  still being written. */
const GRACE_MS = 60 * 60 * 1000;

export async function unusedFileIds(): Promise<string[]> {
  chatStore.flushAll();
  /* Every holder of a file id, not just the conversations. A kept picture is
     the case that made this a list rather than one call: it is reachable only
     from the shelf, so a sweep that asked the conversations alone would report
     it as unused and the one button on that page would delete it. */
  const [conversations, kept, stored] = await Promise.all([
    idbAll<Conversation>(STORE_CONV).catch(() => [] as Conversation[]),
    files.listFigures().catch(() => []),
    files.list()
  ]);
  const used = referencedFileIds(conversations);
  for (const f of kept) if (f.image?.fileId) used.add(f.image.fileId);
  const cutoff = Date.now() - GRACE_MS;
  return stored.filter((f) => !used.has(f.id) && f.created < cutoff).map((f) => f.id);
}
