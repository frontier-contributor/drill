/* ============================================================================
 * AttachMenu — the paperclip, with the kinds of file this model can read.
 *
 * The paperclip used to open the OS file dialog directly, on one static
 * `accept` string of about fifty extensions that had nothing to do with the
 * model on the other end. So the dialog happily offered a photograph to a
 * text-only model, and the first anyone heard about it was a warning on the
 * attachment card *after* it had been read — or, worse, a reply that quietly
 * ignored the picture.
 *
 * This asks first. Each row opens the dialog filtered to that kind, and a kind
 * the model cannot take is greyed and unpressable with the reason in its own
 * second line — the pattern ToolsMenu already uses for a tool the backend
 * cannot run, and for the same argument: "why can't I attach a picture" has to
 * be answerable by looking at the thing itself.
 *
 * Two things are deliberate.
 *
 * **`unknown` stays live.** lib/modality.ts has three states and the third is
 * the point: a local model has no catalogue entry, so rounding it down to "no"
 * would grey the picture row out for every Ollama user and for everybody at
 * all until the catalogue lands.
 *
 * **This is a narrowing, never a gate.** Dropping a file on the page and
 * pasting one both bypass this menu entirely, and they still work — with the
 * warning on the card they always had. services/files/ingest.ts reads the
 * bytes and is the only thing that decides.
 *
 * The button is a plus rather than a paperclip because it adds more than
 * files. "@" and "/" used to be taught by a line of key hints under the box
 * that everyone had read once and then had to look past for ever; they are
 * two rows here instead, so the way to find them is to press the button that
 * says "add", and the bar carries no instructions at all.
 * ========================================================================== */
import { useEffect, useRef, useState } from "react";
import { ATTACH_KINDS, limitOf, type AttachKind, type AttachKindId } from "@/lib/files/kinds";
import type { ModalityVerdict } from "@/lib/modality";
import Icon, { type IconName } from "../ui/Icon";

const KIND_ICON: Record<AttachKindId, IconName> = {
  image: "image",
  pdf: "journal",
  doc: "journal",
  sheet: "cards",
  text: "pencil",
  any: "paperclip"
};

export interface Props {
  disabled: boolean;
  /**
   * What the model that will answer can take, asked once by the caller. The
   * composer knows nothing about models — `warnFor` is the same arrangement —
   * so the verdict arrives already resolved.
   */
  verdicts: Record<string, ModalityVerdict>;
  /** Why a kind is unavailable, by id. Written by the caller so the sentence
   *  naming the model comes from the same place the card's warning does. */
  reasons: Record<string, string>;
  /** Open the file dialog on this kind. */
  onPick: (kind: AttachKind) => void;
  /** Start an "@" reference, or a "/" command, in the box. `command` is null
   *  while there is text in it: a command is the whole message, so offering
   *  one mid-sentence would insert a slash that does nothing. */
  insert?: { mention: () => void; command: (() => void) | null };
}

export default function AttachMenu({ disabled, verdicts, reasons, onPick, insert }: Props) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    /* Capture, and stopped here: Escape in the composer otherwise also reaches
       ChatView, which would close something behind this menu at the same time.
       The same reason ToolsMenu takes it in the capture phase. */
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <div className="attachmenu" ref={wrap}>
      <button
        type="button"
        className={"ctool ctool-icon attach-btn" + (open ? " open" : "")}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        title="Add files, or something of yours"
        aria-label="Add to this message"
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <Icon name="plus" size={19} />
      </button>

      {open && (
        <div className="attach-pop" role="menu">
          <div className="tools-head">Add to this message</div>
          {ATTACH_KINDS.map((k) => {
            /* Live unless the catalogue positively says this model cannot take
               it. No `needs` means anything can read it — a PDF, a Word file
               and a spreadsheet are read here and arrive as text. */
            const verdict = k.needs ? verdicts[k.needs] || "unknown" : "yes";
            const can = verdict !== "no";
            const why = reasons[k.id] || "";
            return (
              <button
                key={k.id}
                className="tools-row attach-row"
                role="menuitem"
                disabled={!can}
                title={can ? k.blurb : why}
                onClick={() => {
                  setOpen(false);
                  onPick(k);
                }}
              >
                <Icon name={KIND_ICON[k.id]} size={14} className="tools-icon" />
                <span className="tools-text">
                  <span className="tools-name">
                    {k.label}
                    {can && limitOf(k.id) && <span className="tools-cost">{limitOf(k.id)}</span>}
                  </span>
                  <span className="tools-blurb">{can ? k.blurb : why}</span>
                </span>
              </button>
            );
          })}

          {insert && (
            <div className="attach-more">
              <button
                className="tools-row attach-row"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  insert.mention();
                }}
              >
                <span className="tools-icon attach-key" aria-hidden="true">@</span>
                <span className="tools-text">
                  <span className="tools-name">Something of yours</span>
                  <span className="tools-blurb">A journal entry, a deck, a card, a memory, a book on the shelf.</span>
                </span>
              </button>
              <button
                className="tools-row attach-row"
                role="menuitem"
                disabled={!insert.command}
                onClick={() => {
                  setOpen(false);
                  insert.command?.();
                }}
              >
                <span className="tools-icon attach-key" aria-hidden="true">/</span>
                <span className="tools-text">
                  <span className="tools-name">A command</span>
                  <span className="tools-blurb">
                    {insert.command ? "Quiz yourself, make cards, remember something, open a board." : "A command is the whole message — clear the box first."}
                  </span>
                </span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
