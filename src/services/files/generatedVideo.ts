/* ============================================================================
 * generatedVideo.ts — a clip the model made, put where files go.
 *
 * The same door a generated picture goes through (generated.ts), for the same
 * reason: a conversation is one record rewritten whole on every message, and
 * megabytes of video inside a variant would be rewritten with it forever. The
 * bytes go to drill-files through the write guard; the variant keeps a
 * reference, and a poster small enough to draw the thread before the file is
 * read.
 *
 * The poster and the measurements come from decoding the clip in a hidden
 * <video>, which a browser is allowed to be slow about or to refuse (a hidden
 * tab, a codec it lacks). Both are bounded by a timeout and both are optional:
 * a clip without a poster is still a clip, and it plays.
 * ========================================================================== */
import * as U from "@/lib/util";
import * as files from "./db";
import type { GeneratedVideo, VideoSpec } from "@/types/chat";

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timed out")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

/** Size, length and an early frame, when the browser will decode it. */
async function probe(blob: Blob): Promise<{ w?: number; h?: number; seconds?: number; poster?: string }> {
  if (typeof document === "undefined") return {};
  const url = URL.createObjectURL(blob);
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.preload = "auto";
  try {
    v.src = url;
    await within(
      new Promise<void>((resolve, reject) => {
        v.onloadeddata = () => resolve();
        v.onerror = () => reject(new Error("could not decode"));
      }),
      6000
    );
    const w = v.videoWidth || undefined;
    const h = v.videoHeight || undefined;
    const seconds = Number.isFinite(v.duration) ? Math.round(v.duration * 10) / 10 : undefined;
    let poster: string | undefined;
    try {
      /* A little way in: the first frame of a generated clip is often black
         or still resolving. */
      v.currentTime = Math.min(0.5, (seconds || 2) / 4);
      await within(new Promise<void>((resolve) => (v.onseeked = () => resolve())), 3000);
      if (w && h) {
        const scale = 240 / Math.max(w, h);
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(w * scale));
        c.height = Math.max(1, Math.round(h * scale));
        c.getContext("2d")?.drawImage(v, 0, 0, c.width, c.height);
        poster = c.toDataURL("image/jpeg", 0.72);
      }
    } catch {
      /* no poster; the clip still plays */
    }
    return { w, h, seconds, poster };
  } catch {
    return {};
  } finally {
    v.removeAttribute("src");
    v.load();
    URL.revokeObjectURL(url);
  }
}

/**
 * Keep a finished clip. Returns undefined when the bytes could not be written
 * — files.put has already raised the save alarm by then, and a record pointing
 * at bytes that were never stored would be a second, quieter failure.
 */
export async function keepVideo(blob: Blob, prompt: string, asked: VideoSpec): Promise<GeneratedVideo | undefined> {
  const mime = blob.type && blob.type.startsWith("video/") ? blob.type : "video/mp4";
  const id = U.uuid();
  const ext = mime.split("/")[1]?.split(";")[0] || "mp4";
  const ok = await files.put({
    id,
    name: `clip-${U.uid("")}.${ext}`,
    mime,
    size: blob.size,
    created: Date.now(),
    blob
  });
  if (!ok) return undefined;
  const facts = await probe(blob);
  return {
    id,
    fileId: id,
    mime,
    size: blob.size,
    w: facts.w,
    h: facts.h,
    seconds: facts.seconds ?? asked.seconds,
    poster: facts.poster,
    prompt: prompt.slice(0, 300),
    asked,
    createdAt: Date.now()
  };
}
