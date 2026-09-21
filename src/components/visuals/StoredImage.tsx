/* ============================================================================
 * StoredImage — a picture out of the file store, on screen.
 *
 * The bytes of anything this app holds live in `drill-files`, never inside the
 * record that points at them, so showing one is always: read the blob, make an
 * object URL, and give it back when the element goes away. Three callers need
 * exactly that — a picture in a reply, a kept one on the shelf, one on a card —
 * and each of them getting it slightly wrong is three ways to leak an object
 * URL.
 *
 * The thumbnail is why this is worth a component rather than a hook. A record
 * carries a 112px JPEG inline, so there is something to draw on the very first
 * frame; the full picture arrives a moment later out of IndexedDB and takes its
 * place. Held blurred and then resolving is not a loading trick dressed up — it
 * is the actual sequence, and the develop animation in figures.css is it made
 * visible.
 *
 * A missing file says so. It is not an error: a backup restored without its
 * files, or a browser that cleared its storage, both land here, and "this
 * picture is not in this browser" is the true and useful sentence.
 * ========================================================================== */
import { useEffect, useState } from "react";
import * as files from "@/services/files/db";

interface Props {
  fileId: string;
  alt: string;
  /** The inline JPEG the record carries, drawn until the real bytes arrive. */
  thumb?: string;
  className?: string;
  /** Handed the object URL once it exists, for a Save button that would
   *  otherwise have to read the same blob a second time. */
  onReady?: (url: string) => void;
}

export default function StoredImage({ fileId, alt, thumb, className, onReady }: Props) {
  const [url, setUrl] = useState<string | null>(null);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    let alive = true;
    let made: string | null = null;
    setUrl(null);
    setGone(false);

    void files.get(fileId).then(
      (rec) => {
        if (!alive) return;
        if (!rec) {
          setGone(true);
          return;
        }
        made = URL.createObjectURL(rec.blob);
        setUrl(made);
        onReady?.(made);
      },
      () => alive && setGone(true)
    );

    return () => {
      alive = false;
      /* Revoked on the way out, including StrictMode's first, discarded mount
         — an object URL lives until the document does otherwise, and a chat
         with forty pictures in it would hold forty decoded images. */
      if (made) URL.revokeObjectURL(made);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId]);

  if (gone) {
    return (
      <div className="photo-gone" role="alert">
        This picture is not in this browser any more — a restored backup made without its files, or storage that was
        cleared.
      </div>
    );
  }

  const src = url || thumb;
  if (!src) return <div className="photo-pending">Opening…</div>;

  return (
    <img
      /* Keyed so the element is replaced when the real bytes land rather than
         mutated: the develop animation has to start again on the sharp one,
         and a class swap on the same node would not restart it. */
      key={url ? "full" : "thumb"}
      className={(className || "photo") + (url ? " photo-in" : " photo-held")}
      src={src}
      alt={alt}
      draggable={false}
    />
  );
}
