/* ============================================================================
 * AttachmentPreview — what was attached, and what the model was actually given.
 *
 * The second half matters more than the first. A PDF's extracted text is what
 * the model reads, and it is the first thing to check when an answer seems to
 * have missed something: a scanned page with no text, a table flattened into
 * a line, a document clipped at the limit. Seeing it takes one click.
 * ========================================================================== */
import { useEffect, useState } from "react";
import * as filesDb from "@/services/files/db";
import { attachmentMeta } from "@/lib/files/parts";
import type { Attachment } from "@/types/chat";
import Icon from "../ui/Icon";

const PREVIEW_CHARS = 60_000;

export default function AttachmentPreview({
  a,
  onClose,
  onMakeCards
}: {
  a: Attachment;
  onClose: () => void;
  onMakeCards?: (text: string) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (!a.fileId || (a.kind !== "image" && a.kind !== "pdf")) return;
    let alive = true;
    let made: string | null = null;
    void filesDb.get(a.fileId).then((rec) => {
      if (!alive) return;
      if (!rec) {
        setMissing(true);
        return;
      }
      /* The type is set here rather than trusted from the stored blob: a file
         only becomes a PDF or a picture in this app by passing the byte check
         in lib/files/sniff, and the URL should say exactly that and nothing
         a browser might render as a page. */
      made = URL.createObjectURL(new Blob([rec.blob], { type: a.kind === "pdf" ? "application/pdf" : rec.mime }));
      setUrl(made);
    });
    return () => {
      alive = false;
      /* Late, so a PDF opened in a new tab a moment before closing this has
         time to load from the URL before it stops existing. */
      if (made) {
        const u = made;
        setTimeout(() => URL.revokeObjectURL(u), 60_000);
      }
    };
  }, [a.fileId, a.kind]);

  const shown = a.text.length > PREVIEW_CHARS ? a.text.slice(0, PREVIEW_CHARS) + "\n\n[… the preview stops here; the model has the rest]" : a.text;

  return (
    <div
      className="sheet"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sheet-inner attprev" role="dialog" aria-label={a.name}>
        <div className="sheet-head">
          <h3>{a.name}</h3>
          <span className="sub">{attachmentMeta(a)}</span>
          <button className="iconbtn" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        <div className="sheet-body">
          {a.kind === "image" &&
            (url ? (
              <img className="attprev-img" src={url} alt={a.name} />
            ) : (
              <div className="empty">{missing ? "This picture is no longer in this browser." : "Opening…"}</div>
            ))}

          {a.kind === "pdf" && a.thumb && <img className="attprev-page" src={a.thumb} alt="" />}

          {a.scanned?.length ? (
            <p className="sset-note warn">
              {a.scanned.length === 1 ? `Page ${a.scanned[0]} has` : `Pages ${a.scanned.slice(0, 12).join(", ")}${a.scanned.length > 12 ? "…" : ""} have`} no
              text layer — scans.{" "}
              {a.pageImages?.length
                ? `${a.pageImages.length === a.scanned.length ? "They go" : `The first ${a.pageImages.length} go`} to a model that can see as pictures.`
                : "A model reading this text will not see them."}
            </p>
          ) : null}

          {a.truncated && <p className="sset-note warn">Clipped at the limit — the model is told where it stops.</p>}

          {a.kind !== "image" && (
            <>
              <label className="f">What the model reads</label>
              {shown.trim() ? <pre className="attprev-text">{shown}</pre> : <div className="empty">No text in this file.</div>}
            </>
          )}

          <div className="btnrow">
            {a.kind === "pdf" && url && (
              <button className="btn sm" onClick={() => window.open(url, "_blank", "noopener")}>
                Open the PDF
              </button>
            )}
            {onMakeCards && a.text.trim() && (
              <button
                className="btn sm"
                onClick={() => {
                  onMakeCards(a.text);
                  onClose();
                }}
              >
                Make cards from this
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
