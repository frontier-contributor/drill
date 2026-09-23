/* ============================================================================
 * Composer — the input, its attachments, and the slash menu.
 *
 * Slash commands exist because the integrations are worthless if you have to
 * go hunting for them in a menu mid-thought. Typing "/" and three letters
 * keeps quizzing, card-making and context-attaching inside the flow of the
 * conversation.
 *
 * "@" is the other half. A slash command *does* something; an "@" points at
 * something you already have — a journal entry, a book on the project shelf,
 * a deck, a card, a memory — and rides along with this one message.
 *
 * Files are the third way in: pictures, PDFs, Word, Excel, text and code, by
 * the paperclip, by pasting a screenshot, or by dropping anywhere on the chat
 * column (ChatView hands those in as `dropped`). Every one goes through
 * services/files/ingest, which reads it in this browser before anything is
 * sent — so the card can say what the model will get, and Send waits until
 * there is something to send.
 *
 * Note the difference from conversation context, which is standing policy
 * attached to every message in the thread. A reference or an attachment is for
 * the sentence you are writing now — unless it is pinned.
 *
 * One box, two rows, and nothing written on it. The text is the top row and
 * gets the room; the bottom row is glyphs — add, how to answer, the switches —
 * on the left, and the model and Send on the right, because what the message
 * is set to and what will answer it are different questions and the gap
 * between them is what stops the row reading as an instrument panel.
 *
 * It used to be cleverer and worse. The tool row hid until the box had focus,
 * which saved 40px while reading and cost every newcomer the discovery that
 * there was a model picker at all; and under it ran a line of key hints
 * ("enter sends · shift+enter newline · / and @") that everyone read once and
 * then looked past for ever. The row is always there now, it is quiet enough
 * not to need hiding, and "@" and "/" are rows in the + menu instead of
 * instructions on the bar. The shortcuts sheet still lists the keys.
 *
 * The corner button makes the box tall, for the message that is a page rather
 * than a line. It is not remembered: a long draft is the exception, and a
 * composer that stayed half the screen after it was sent would be taking the
 * transcript's room back for nothing.
 * ========================================================================== */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as U from "@/lib/util";
import { KIND_LABEL, search, toAttachment, type Reference } from "@/lib/references";
import { attachmentTokens, fileIdsOf } from "@/lib/files/parts";
import { ingest } from "@/services/files/ingest";
import * as filesDb from "@/services/files/db";
import type { Attachment } from "@/types/chat";
import type { ModalityVerdict } from "@/lib/modality";
import AttachMenu from "./AttachMenu";
import Icon from "../ui/Icon";
import AttachmentCard, { type PendingFile } from "./AttachmentCard";

export interface SlashCommand {
  cmd: string;
  desc: string;
  /** run instead of sending; returns text to leave in the box, if any */
  run: (arg: string) => void;
}

interface Props {
  disabled: boolean;
  busy: boolean;
  placeholder?: string;
  commands: SlashCommand[];
  /** Everything referenceable, rebuilt by the caller so the composer never
   *  reaches into the stores itself. */
  references: Reference[];
  /** The left of the tool row: the Tools menu and whatever it has switched on.
   *  Passed in rather than built here so the composer stays ignorant of
   *  conversations. */
  tools?: ReactNode;
  /** The right of the tool row — the model chip. Separated from `tools`
   *  because the split is the layout: what the message is set to sits on one
   *  side, what will answer it on the other, and the gap between them is what
   *  stops six controls reading as one undifferentiated row. */
  trailing?: ReactNode;
  onSend: (text: string, attachments: Attachment[]) => void;
  onStop: () => void;
  /** set to a string to overwrite the draft from outside (follow-up chips) */
  seed?: { text: string; nonce: number } | null;
  /** Files dropped anywhere on the chat column. `droppedNonce` says new ones
   *  are waiting and `takeDropped` hands them over exactly once. A prop that
   *  held the files themselves was read again by the composer that mounts when
   *  the first message creates a conversation — every dropped file attached a
   *  second time, and a third under StrictMode — so the files are taken, not
   *  passed. */
  droppedNonce?: number;
  takeDropped?: () => File[];
  /** What an attachment's card should warn about the model on the other end —
   *  "cannot see images". Asked of the caller, because the composer knows
   *  nothing about models. */
  warnFor?: (a: Attachment) => string | null;
  /** What that model can take, and what to say about a kind it cannot. Asked
   *  of the caller for the same reason `warnFor` is: this component resolves
   *  no models, and the menu and the card must not disagree about one. */
  attachVerdicts?: Record<string, ModalityVerdict>;
  attachReasons?: Record<string, string>;
  onPreview?: (a: Attachment) => void;
}

export default function Composer({
  disabled,
  busy,
  placeholder,
  commands,
  references,
  tools,
  trailing,
  onSend,
  onStop,
  seed,
  droppedNonce,
  takeDropped,
  warnFor,
  attachVerdicts,
  attachReasons,
  onPreview
}: Props) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [slashSel, setSlashSel] = useState(0);
  const [refSel, setRefSel] = useState(0);
  /** Where the caret was when the last change happened. The "@" token is
   *  found by looking backwards from here, not from the end of the text, so a
   *  reference can be dropped into the middle of a sentence. */
  const [caret, setCaret] = useState(0);
  /** Set the moment a reference is chosen (or the picker is dismissed), and
   *  cleared by the next keystroke. Without it the menu reopens on its own
   *  inserted token: the caret moves in a rAF *after* React has re-rendered
   *  with the new text and the old caret, and that one frame is enough to
   *  match "@" again and leave the menu stuck open. */
  const [refOff, setRefOff] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  /** One controller for every file being read in this composer. Aborted when
   *  the composer goes away — it is keyed on the conversation, so switching
   *  threads mid-PDF stops reading it — and cleared, so StrictMode's second
   *  mount starts a fresh one rather than inheriting an aborted signal. */
  const ingestCtl = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      ingestCtl.current?.abort();
      ingestCtl.current = null;
    };
  }, []);

  useEffect(() => {
    if (seed?.text) {
      setText(seed.text);
      ref.current?.focus();
    }
  }, [seed?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const files = takeDropped?.() || [];
    if (files.length) addFiles(files);
  }, [droppedNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Autosize. An empty box is left at its one-row default rather than
     measured: Chrome counts a wrapped *placeholder* in scrollHeight, so on a
     narrow screen the composer opened two lines tall before a single
     character had been typed. */
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    /* Expanded, the stylesheet's min-height holds the room open and this only
       lets a longer draft grow past it, to a cap measured against the window
       rather than a fixed 220px — the point of expanding is more than 220px. */
    const cap = expanded ? Math.round(window.innerHeight * 0.6) : 220;
    if (text) el.style.height = Math.min(el.scrollHeight, cap) + "px";
  }, [text, expanded]);

  const slashQuery = useMemo(() => {
    // only when "/" opens the message and no space has been typed yet
    const m = /^\/(\w*)$/.exec(text);
    return m ? m[1].toLowerCase() : null;
  }, [text]);

  /* The "@" token immediately before the caret, if there is one. Anchored to
     a word boundary so an email address does not open the picker, and with
     brackets excluded so the "@[journal: ...]" token this inserts cannot
     match itself and hold the menu open. */
  const refQuery = useMemo(() => {
    if (refOff) return null;
    const before = text.slice(0, caret);
    const m = /(?:^|\s)@([^\n@\[\]]{0,40})$/.exec(before);
    if (!m) return null;
    return m[1];
  }, [text, caret, refOff]);

  const refMatches = useMemo(
    () => (refQuery == null ? [] : search(references, refQuery)),
    [refQuery, references]
  );

  useEffect(() => setRefSel(0), [refQuery]);

  const matches = useMemo(
    () => (slashQuery == null ? [] : commands.filter((c) => c.cmd.slice(1).startsWith(slashQuery))),
    [slashQuery, commands]
  );

  useEffect(() => setSlashSel(0), [slashQuery]);

  /** Still reading a file — Send waits, rather than sending a message whose
   *  attachment arrives a second after it. A failed file does not block. */
  const reading = pending.some((p) => !p.error);

  /** Swap the "@query" token for a readable label and attach the material.
   *  The label stays in the text so the sentence still reads as a sentence
   *  when you look at it later — "compare @[journal: 2026-9-1] with today". */
  function pickRef(r: Reference) {
    const before = text.slice(0, caret);
    const after = text.slice(caret);
    const token = /(?:^|\s)@([^\n@\[\]]{0,40})$/.exec(before);
    const cut = token ? before.length - token[1].length - 1 : before.length;
    const label = `@[${KIND_LABEL[r.kind]}: ${r.label}] `;
    const next = before.slice(0, cut) + label + after;
    setText(next);
    setRefOff(true);
    setAttachments((prev) => (prev.some((a) => a.name === `${KIND_LABEL[r.kind]}: ${r.label}`) ? prev : [...prev, toAttachment(r)]));
    const pos = cut + label.length;
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  }

  function runSlash(c: SlashCommand) {
    const arg = text.replace(/^\/\w*\s*/, "");
    setText("");
    c.run(arg);
  }

  function submit() {
    if (busy || disabled || reading) return;
    const body = text.trim();
    if (!body && !attachments.length) return;

    // "/cmd rest of line" dispatches instead of sending
    const m = /^\/(\w+)(?:\s+([\s\S]*))?$/.exec(body);
    if (m) {
      const found = commands.find((c) => c.cmd === "/" + m[1].toLowerCase());
      if (found) {
        setText("");
        found.run((m[2] || "").trim());
        return;
      }
    }

    onSend(body, attachments);
    setText("");
    setAttachments([]);
    setPending([]);
    setExpanded(false);
  }

  /** Type `insert` at the caret and hand focus back to the box — what the +
   *  menu's "@" and "/" rows do. A space goes before an "@" that would
   *  otherwise touch a word, because the picker only opens on an "@" that
   *  starts one. */
  function typeAtCaret(insert: string) {
    const at = ref.current?.selectionStart ?? text.length;
    const before = text.slice(0, at);
    const lead = insert === "@" && before && !/\s$/.test(before) ? " " : "";
    const pos = at + lead.length + insert.length;
    setText(before + lead + insert + text.slice(at));
    setRefOff(false);
    setCaret(pos);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (refMatches.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setRefSel((i) => (i + 1) % refMatches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setRefSel((i) => (i - 1 + refMatches.length) % refMatches.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        pickRef(refMatches[refSel]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setRefOff(true); // closes it without touching what was typed
        return;
      }
    }
    if (matches.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashSel((i) => (i + 1) % matches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashSel((i) => (i - 1 + matches.length) % matches.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        runSlash(matches[slashSel]);
        return;
      }
      if (e.key === "Escape") {
        setText("");
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function addFiles(list: FileList | File[]) {
    const incoming = Array.from(list);
    if (!incoming.length) return;
    if (!ingestCtl.current) ingestCtl.current = new AbortController();
    const signal = ingestCtl.current.signal;
    for (const file of incoming) {
      const id = U.uid("p");
      setPending((p) => [...p, { id, name: file.name || "file", label: "Reading" }]);
      ingest(file, {
        signal,
        onProgress: (pr) =>
          setPending((p) => p.map((x) => (x.id === id ? { ...x, label: pr.label, done: pr.done, total: pr.total } : x)))
      })
        .then((a) => {
          if (signal.aborted) return;
          setPending((p) => p.filter((x) => x.id !== id));
          setAttachments((prev) => [...prev, a]);
        })
        .catch((e: unknown) => {
          if (signal.aborted) return;
          const message = (e as Error)?.message || "This file could not be read.";
          setPending((p) => p.map((x) => (x.id === id ? { ...x, error: message } : x)));
        });
    }
  }

  /** Removing an attachment that was never sent also removes its kept bytes —
   *  nothing else will ever point at them. */
  function removeAttachment(a: Attachment) {
    setAttachments((p) => p.filter((x) => x.id !== a.id));
    const ids = fileIdsOf(a);
    if (ids.length) void filesDb.remove(ids);
  }

  function togglePin(id: string) {
    setAttachments((p) => p.map((x) => (x.id === id ? { ...x, pinned: !x.pinned } : x)));
  }

  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    /* A screenshot on the clipboard arrives as a file called "image.png", every
       time — named here so three pasted screenshots are not three identical
       cards. */
    const files = Array.from(e.clipboardData.files || []);
    if (files.length) {
      e.preventDefault();
      const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, "");
      addFiles(
        files.map((f, i) =>
          f.name && f.name !== "image.png" ? f : new File([f], `screenshot-${stamp}${i ? "-" + (i + 1) : ""}.png`, { type: f.type })
        )
      );
      return;
    }
    const pasted = e.clipboardData.getData("text");
    // A very large paste is a document, not a sentence: file it as an
    // attachment so the composer stays readable.
    if (pasted.length > 4000) {
      e.preventDefault();
      setAttachments((prev) => [
        ...prev,
        { id: U.uid("a"), name: `pasted-${prev.length + 1}.txt`, kind: "selection", size: pasted.length, text: pasted }
      ]);
    }
  }

  const attachedTokens = attachments.reduce((n, a) => n + attachmentTokens(a), 0);
  const canSend = !disabled && !reading && (!!text.trim() || attachments.length > 0);

  return (
    <div className="composer">
      <div className="composer-inner">
        {matches.length > 0 && (
          <div className="slashmenu">
            {matches.map((c, i) => (
              <button key={c.cmd} className={"slashitem" + (i === slashSel ? " sel" : "")} onClick={() => runSlash(c)}>
                <span className="cmd">{c.cmd}</span>
                <span className="desc">{c.desc}</span>
              </button>
            ))}
          </div>
        )}

        {refMatches.length > 0 && (
          <div className="slashmenu refmenu">
            <div className="refmenu-head">Refer to something of yours</div>
            {refMatches.map((r, i) => (
              <button
                key={r.id}
                className={"slashitem" + (i === refSel ? " sel" : "")}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickRef(r);
                }}
              >
                <span className="cmd">{KIND_LABEL[r.kind]}</span>
                <span className="reflabel">{r.label}</span>
                <span className="desc">{r.hint}</span>
              </button>
            ))}
          </div>
        )}

        <div className={"composer-box" + (expanded ? " expanded" : "")}>
          {(attachments.length > 0 || pending.length > 0) && (
            <div className="att-row">
              {attachments.map((a) => (
                <AttachmentCard
                  key={a.id}
                  a={a}
                  warn={warnFor?.(a) ?? null}
                  onOpen={onPreview ? () => onPreview(a) : undefined}
                  onPin={() => togglePin(a.id)}
                  onRemove={() => removeAttachment(a)}
                />
              ))}
              {pending.map((p) => (
                <AttachmentCard
                  key={p.id}
                  pending={p}
                  onRemove={p.error ? () => setPending((x) => x.filter((y) => y.id !== p.id)) : undefined}
                />
              ))}
            </div>
          )}

          <div className="composer-field">
            <textarea
              ref={ref}
              rows={1}
              value={text}
              disabled={disabled}
              placeholder={placeholder || "Ask anything"}
              onChange={(e) => {
                setText(e.target.value);
                setCaret(e.target.selectionStart ?? e.target.value.length);
                setRefOff(false);
              }}
              onKeyUp={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
              onClick={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
            />
            <button
              type="button"
              className="composer-grow"
              onClick={() => {
                setExpanded((v) => !v);
                ref.current?.focus();
              }}
              title={expanded ? "Make the box small again" : "Make the box tall, for a long message"}
              aria-label={expanded ? "Collapse the message box" : "Expand the message box"}
              aria-pressed={expanded}
            >
              <Icon name={expanded ? "collapse" : "expand"} size={14} />
            </button>
          </div>

          <div className="composer-tools">
            <div className="ctools-left">
              <AttachMenu
                disabled={disabled}
                verdicts={attachVerdicts || {}}
                reasons={attachReasons || {}}
                insert={{
                  mention: () => typeAtCaret("@"),
                  command: text ? null : () => typeAtCaret("/")
                }}
                onPick={(kind) => {
                  const el = fileRef.current;
                  if (!el) return;
                  /* Set on the node rather than through React, and clicked in
                     the same tick. A browser only opens a file dialog inside a
                     user gesture, and waiting a frame for React to render the
                     attribute is a frame spent outside one. React never
                     manages `accept` here, so nothing re-renders it away. */
                  el.accept = kind.accept;
                  el.click();
                }}
              />
              <input
                ref={fileRef}
                type="file"
                multiple
                className="hidden-file"
                onChange={(e) => {
                  if (e.target.files) addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              {tools}
            </div>
            <div className="ctools-right">
              {attachedTokens > 0 && <span className="composer-hint">~{attachedTokens.toLocaleString()} tok</span>}
              {trailing}
              {busy ? (
                <button className="csend stop" onClick={onStop} title="Stop generating" aria-label="Stop generating">
                  <Icon name="stop" size={13} />
                </button>
              ) : (
                <button
                  className="csend"
                  onClick={submit}
                  disabled={!canSend}
                  title={reading ? "Still reading the attached file" : "Send  (enter)"}
                  aria-label="Send"
                >
                  <Icon name="arrow-up" size={17} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
