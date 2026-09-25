/* ============================================================================
 * Clip — a video the model made, inside a reply.
 *
 * The same frame as Picture and Visual — the bar, the label, the actions in
 * the same order — so a clip and a picture in one thread read as two of a
 * kind. It plays from the file store: the bytes are in drill-files, read into
 * an object URL when the reply is on screen and given back when it is not, so
 * a thread of ten clips does not hold ten videos in memory.
 *
 * The poster is the frame drawn when the clip was kept, and it is what shows
 * before the file is read; a clip kept by a browser that could not decode it
 * has none, and simply shows the player.
 * ========================================================================== */
import { useEffect, useRef, useState } from "react";
import * as files from "@/services/files/db";
import { size } from "@/lib/files/limits";
import type { GeneratedVideo } from "@/types/chat";

export default function Clip({ video }: { video: GeneratedVideo }) {
  const [url, setUrl] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const figRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let alive = true;
    let made: string | null = null;
    setUrl(null);
    setGone(false);
    void files.get(video.fileId).then(
      (rec) => {
        if (!alive) return;
        if (!rec) return setGone(true);
        made = URL.createObjectURL(rec.blob);
        setUrl(made);
      },
      () => alive && setGone(true)
    );
    return () => {
      alive = false;
      /* Revoked on the way out, StrictMode's discarded mount included. */
      if (made) URL.revokeObjectURL(made);
    };
  }, [video.fileId]);

  const title = video.prompt ? video.prompt.slice(0, 70) : "Video";
  const ext = video.mime.split("/")[1]?.split(";")[0] || "mp4";

  function save(): void {
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(video.prompt || "clip").replace(/[^\w -]+/g, "").trim().slice(0, 40) || "clip"}.${ext}`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 800);
  }

  const asked = video.asked;
  const facts = [
    video.w && video.h ? `${video.w}×${video.h}` : asked?.resolution,
    video.seconds ? `${video.seconds}s` : undefined,
    size(video.size),
    asked?.audio === false ? "no sound" : undefined
  ].filter(Boolean);

  return (
    <figure className="vis vis-clip" ref={figRef}>
      <div className="vis-bar">
        <span className="vis-label">Video</span>
        <span className="vis-title">{title}</span>
        <span className="vis-acts">
          <button type="button" className="tact" onClick={save} disabled={!url}>
            {ext.toUpperCase()}
          </button>
          <button type="button" className="tact" onClick={() => void figRef.current?.requestFullscreen?.()}>
            Full screen
          </button>
        </span>
      </div>
      {gone ? (
        <div className="photo-gone" role="alert">
          This clip is not in this browser any more — a restored backup made without its files, or storage that was cleared.
        </div>
      ) : (
        <video
          className="vis-video"
          controls
          playsInline
          preload="metadata"
          poster={video.poster}
          src={url || undefined}
          aria-label={video.prompt || "A clip the model made"}
        />
      )}
      <figcaption className="vis-foot">{facts.join(" · ")}</figcaption>
    </figure>
  );
}
