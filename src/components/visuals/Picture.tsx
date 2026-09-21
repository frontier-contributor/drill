/* ============================================================================
 * Picture — a picture the model drew, inside a reply, with what you can do
 * with it.
 *
 * Deliberately the same frame as `Visual`: the bar, the label, the actions in
 * the same order, so a diagram and a photograph in the same reply read as two
 * of a kind rather than as two features. What differs is only what is true of
 * each — a picture has no source to show and nothing to "ask to fix", and it
 * arrives by developing rather than by being drawn (figures.css).
 *
 * Keep puts it on the same shelf a figure goes to. A generated picture is the
 * clearest case the shelf exists for: it cost real money, it is not
 * reproducible — ask again and you get a different picture — and it is four
 * hundred messages back by Thursday.
 * ========================================================================== */
import { useRef, useState } from "react";
import * as figures from "@/services/figures";
import { useStoreSync } from "@/hooks/useStoreSync";
import { useRoute } from "@/context/RouteContext";
import { useToast } from "@/context/ToastContext";
import { size } from "@/lib/files/limits";
import type { GeneratedImage } from "@/types/chat";
import StoredImage from "./StoredImage";

interface Props {
  image: GeneratedImage;
  /** Where a kept copy would be filed. Absent on the shelf, where it already
   *  is one — the same arrangement `Visual` uses. */
  keep?: { projectId: string; conversationId?: string; conversationTitle?: string };
  onMakeCards?: (text: string) => void;
}

export default function Picture({ image, keep, onMakeCards }: Props) {
  useStoreSync(figures);
  const toast = useToast();
  const { openFigures } = useRoute();
  const figRef = useRef<HTMLElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const [saving, setSaving] = useState(false);

  /* The file id is what identifies a kept picture (lib/visuals/keep.ts), so
     this is an exact lookup rather than a comparison of anything fuzzy. */
  const shelved = keep
    ? figures.keptFor({ kind: "image", info: "", source: image.fileId }, keep)
    : undefined;

  const title = image.prompt ? image.prompt.slice(0, 70) : "Picture";

  function onKeep(): void {
    if (!keep) return;
    if (shelved) {
      openFigures(shelved.id);
      return;
    }
    const { figure } = figures.keep({
      block: { kind: "image", info: "", source: image.fileId },
      image: { fileId: image.fileId, mime: image.mime, w: image.w, h: image.h, size: image.size, thumb: image.thumb },
      title,
      ...keep
    });
    toast(`Kept in Figures — “${figure.title}”`);
  }

  function save(): void {
    const url = urlRef.current;
    if (!url) return;
    setSaving(true);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(image.prompt || "picture").replace(/[^\w -]+/g, "").trim().slice(0, 40) || "picture"}.png`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      setSaving(false);
    }, 800);
  }

  return (
    <figure className="vis vis-image" ref={figRef}>
      <div className="vis-bar">
        <span className="vis-label">Image</span>
        <span className="vis-title">{title}</span>
        <span className="vis-acts">
          {keep && (
            <button
              type="button"
              className={"tact" + (shelved ? " on" : "")}
              onClick={onKeep}
              title={shelved ? "On the shelf — open it in Figures" : "Keep this picture in the Figures section"}
            >
              {shelved ? "Kept" : "Keep"}
            </button>
          )}
          <button type="button" className="tact" onClick={save} disabled={saving}>
            PNG
          </button>
          <button type="button" className="tact" onClick={() => void figRef.current?.requestFullscreen?.()}>
            Full screen
          </button>
          {onMakeCards && (
            <button
              type="button"
              className="tact"
              /* The picture cannot go on the card — the card writer reads text
                 — so what travels is what it was asked for. A card written
                 from the prompt is about the same idea. */
              onClick={() => onMakeCards(`A picture the learner asked for and kept: ${image.prompt || title}`)}
            >
              Make cards
            </button>
          )}
        </span>
      </div>
      <StoredImage
        fileId={image.fileId}
        thumb={image.thumb}
        alt={image.prompt || "A picture the model drew"}
        className="vis-photo"
        onReady={(url) => (urlRef.current = url)}
      />
      <figcaption className="vis-foot">
        {image.w}×{image.h} · {size(image.size)}
      </figcaption>
    </figure>
  );
}
