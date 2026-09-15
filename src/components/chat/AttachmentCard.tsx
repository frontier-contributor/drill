/* ============================================================================
 * AttachmentCard — one attached thing, in the composer and under a message.
 *
 * A chip used to say only the file name, which was enough when everything was
 * a text file. With pictures and PDFs it is not enough to decide anything, so
 * the card says what it is, how big, roughly what it costs to send, and —
 * before you press Send rather than after the reply ignores it — whether the
 * model on the other end can take it at all.
 * ========================================================================== */
import { attachmentMeta, kindBadge } from "@/lib/files/parts";
import type { Attachment } from "@/types/chat";
import Icon from "../ui/Icon";

/** A file still being read, or one that could not be. */
export interface PendingFile {
  id: string;
  name: string;
  label: string;
  done?: number;
  total?: number;
  error?: string;
}

interface Props {
  a?: Attachment;
  pending?: PendingFile;
  warn?: string | null;
  onOpen?: () => void;
  onPin?: () => void;
  onRemove?: () => void;
}

export default function AttachmentCard({ a, pending, warn, onOpen, onPin, onRemove }: Props) {
  if (pending) {
    const failed = !!pending.error;
    const progress = pending.total ? ` ${pending.done || 0}/${pending.total}` : "…";
    return (
      <div className={"attcard" + (failed ? " bad" : " busy")} role={failed ? "alert" : "status"}>
        <span className="attcard-badge">{failed ? "!" : "···"}</span>
        <span className="attcard-text">
          <span className="attcard-name">{pending.name}</span>
          <span className="attcard-meta" title={pending.error}>
            {failed ? pending.error : pending.label + progress}
          </span>
        </span>
        {onRemove && (
          <button type="button" className="attcard-act" onClick={onRemove} aria-label={`Dismiss ${pending.name}`}>
            <Icon name="close" size={11} />
          </button>
        )}
      </div>
    );
  }
  if (!a) return null;

  const meta = warn || attachmentMeta(a);
  return (
    <div className={"attcard" + (warn ? " warn" : "") + (a.pinned ? " pinned" : "")}>
      <button type="button" className="attcard-main" onClick={onOpen} disabled={!onOpen} title={warn || (onOpen ? "Preview" : undefined)}>
        {a.thumb ? <img className="attcard-thumb" src={a.thumb} alt="" /> : <span className="attcard-badge">{kindBadge(a)}</span>}
        <span className="attcard-text">
          <span className="attcard-name">{a.name}</span>
          <span className="attcard-meta">{meta}</span>
        </span>
      </button>
      {onPin && (
        <button
          type="button"
          className={"attcard-act" + (a.pinned ? " on" : "")}
          onClick={onPin}
          aria-pressed={!!a.pinned}
          title={a.pinned ? "Pinned — sent with every message in this chat" : "Pin to this chat, so every message carries it"}
        >
          <Icon name="pin" size={11} />
        </button>
      )}
      {onRemove && (
        <button type="button" className="attcard-act" onClick={onRemove} aria-label={`Remove ${a.name}`}>
          <Icon name="close" size={11} />
        </button>
      )}
    </div>
  );
}
