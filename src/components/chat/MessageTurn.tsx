/* ============================================================================
 * MessageTurn — one exchange, plus everything you can do with it.
 *
 * The action row is where this stops being a generic chat client: any reply
 * can become flashcards, an insight-log entry, or the root of a new
 * conversation without leaving the thread.
 *
 * A long reply also gets a contents. Drill hides every scrollbar in the app
 * on purpose, which leaves a two-thousand-word answer looking exactly like a
 * two-hundred-word one until you have scrolled through it — so a book's
 * answer to that problem is borrowed directly: how long this is, what is in
 * it, and a way to turn straight to the part you wanted.
 * ========================================================================== */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as store from "@/services/store";
import { renderReply, markdownToText } from "@/lib/markdown";
import { kindsOn } from "@/lib/visuals/catalogue";
import { canvasId, canvasVersions } from "@/lib/visuals/artifacts";
import Visual from "../visuals/Visual";
import Picture from "../visuals/Picture";
import ErrorGuard from "../ui/ErrorGuard";
import MemorySaved from "./MemorySaved";
import AgentTrace, { stepsFromTrace } from "./AgentTrace";
import type { AgentLive, ThinkingLive } from "@/context/ChatContext";
import ThinkingPanel from "./ThinkingPanel";
import Sources from "./Sources";
import RegenerateMenu from "./RegenerateMenu";
import ListenButton from "./ListenButton";
import { useReadingHighlight } from "./useReadingHighlight";
import { formatCost, formatTokens } from "@/lib/tokens";
import * as AI from "@/services/ai";
import * as chatStore from "@/services/chatStore";
import { useToast } from "@/context/ToastContext";
import type { Attachment, Conversation, Turn } from "@/types/chat";
import AttachmentCard from "./AttachmentCard";
import type { BackendType } from "@/types";
import Icon from "../ui/Icon";

/* One selector, used to build the contents and to jump within it. */
const HEADINGS = "h1, h2, h3";

interface Props {
  turn: Turn;
  isLast: boolean;
  /** The agent loop mid-flight, when this is the turn being answered into.
   *  Null everywhere else, including in chat mode. */
  agentLive?: AgentLive | null;
  /** The model's working mid-flight, on the turn being answered into. Same
   *  rule as agentLive: handed down rather than read from context, so exactly
   *  one turn can ever show it. */
  thinking?: ThinkingLive | null;
  streamingText: string | null;
  busy: boolean;
  /** Backend/model of the conversation this turn belongs to, so Regenerate
   *  can offer "try a different model" without pinning the thread to it. */
  conversation: Conversation;
  onRegenerate: (override?: { backend?: BackendType | ""; model?: string }) => void;
  onEdit: (text: string) => void;
  onBranch: () => void;
  onMakeCards: (text: string) => void;
  onSaveNote: (text: string) => void;
  onVariant: (i: number) => void;
  onStar: () => void;
  onDelete: () => void;
  onRetry: () => void;
  onOpenAttachment?: (a: Attachment) => void;
  /** Hands a diagram to the whiteboard, where it becomes shapes you can move. */
  onOpenBoard?: (from: { mermaid: string; title: string }) => void;
  /** Send the model the reason one of its figures would not draw. An ordinary
   *  message, so it costs what a message costs and nothing goes out unasked. */
  onAskFix?: (message: string) => void;
}

export default function MessageTurn({
  turn,
  isLast,
  agentLive,
  thinking,
  streamingText,
  busy,
  conversation,
  onRegenerate,
  onEdit,
  onBranch,
  onMakeCards,
  onSaveNote,
  onVariant,
  onStar,
  onDelete,
  onRetry,
  onOpenAttachment,
  onOpenBoard,
  onAskFix
}: Props) {
  const toast = useToast();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  /* The reply's own markup, without the trace, sources and saved-memory
     blocks that share its body — only this is read aloud. */
  const mdRef = useRef<HTMLSpanElement | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  /* Shut by default: the summary line is the useful part at a glance, and a
     five-line list unfolding above every long answer would cost more reading
     height than it gives back. */
  const [tocOpen, setTocOpen] = useState(false);

  const isUser = turn.role === "user";
  const streaming = streamingText != null;
  const content = streaming ? streamingText : chatStore.activeContent(turn);
  const variant = turn.variants[turn.active];

  /* Which kinds of figure are switched on. ChatView subscribes to the store,
     so turning one off redraws every reply on screen. */
  const kinds = kindsOn(store.settings().visualsOff);
  const kindsKey = kinds.join(",");
  const rendered = useMemo(
    () => (isUser ? { html: "", visuals: [] } : renderReply(content, kinds)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [content, isUser, kindsKey]
  );
  const html = rendered.html;

  /* Every version of every canvas in the thread, so one shown in this reply
     can offer the ones written before it. Derived from the transcript, which
     is where a canvas lives; only worked out when this reply has one. */
  const canvases = useMemo(
    () =>
      rendered.visuals.some((v) => v.kind === "canvas")
        ? canvasVersions(conversation.turns.map((t) => t.variants[t.active]?.content || ""))
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rendered, conversation.turns.length]
  );

  /* The slots the markdown left for figures, read back off the DOM once it has
     landed. Never while streaming: the fence is still open, so the block is
     half written, and half a diagram is an error message. */
  const [slots, setSlots] = useState<HTMLElement[]>([]);
  useLayoutEffect(() => {
    const root = mdRef.current;
    setSlots(!root || streaming ? [] : Array.from(root.querySelectorAll<HTMLElement>(".vis-slot")));
  }, [html, streaming]);

  /* Read off the rendered HTML rather than the markdown source, so the list
     and the headings it scrolls to are the same query over the same tree and
     cannot drift apart. Not while streaming: the outline would be rebuilt on
     every token and would grow under the reader's hand. */
  const outline = useMemo(() => {
    if (isUser || streaming || !html) return null;
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    const heads = Array.from(tpl.content.querySelectorAll(HEADINGS)).map((h) => ({
      level: Number(h.tagName[1]),
      text: (h.textContent || "").trim()
    }));
    const words = (tpl.content.textContent || "").trim().split(/\s+/).filter(Boolean).length;
    return { heads, words, minutes: Math.max(1, Math.round(words / 220)) };
  }, [html, isUser, streaming]);

  const hasToc = !!outline && outline.heads.length >= 3;

  /* Whether this reply is the one being read aloud: its current sentence is
     lit, and its action row — and so its Pause — stays showing. */
  const listening = useReadingHighlight({
    conversationId: conversation.id,
    turnId: turn.id,
    variant: turn.active,
    html,
    root: mdRef,
    enabled: !isUser && !streaming
  });

  /* By index, against the live DOM — the same selector the outline was built
     from, so item n is heading n however the markdown was written. */
  function jump(i: number) {
    const el = bodyRef.current?.querySelectorAll(HEADINGS)[i] as HTMLElement | undefined;
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* Code-block copy buttons are rendered as raw HTML by the markdown pipeline,
     so their clicks are picked up here by delegation rather than by React. */
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || isUser) return;
    const onClick = (e: MouseEvent) => {
      const btn = (e.target as HTMLElement).closest("[data-copy]");
      if (!btn) return;
      const block = btn.closest(".codeblock") as HTMLElement | null;
      const code = block?.dataset.code;
      if (code == null) return;
      void navigator.clipboard.writeText(code).then(
        () => {
          btn.textContent = "Copied";
          setTimeout(() => (btn.textContent = "Copy"), 1400);
        },
        () => toast("Clipboard refused — copy manually")
      );
    };
    el.addEventListener("click", onClick);
    return () => el.removeEventListener("click", onClick);
  }, [html, isUser, toast]);

  function beginEdit() {
    setDraft(chatStore.activeContent(turn));
    setEditing(true);
  }

  function commitEdit() {
    const text = draft.trim();
    setEditing(false);
    if (!text || text === chatStore.activeContent(turn)) return;
    onEdit(text);
  }

  function copyAll() {
    void navigator.clipboard.writeText(content).then(
      () => toast("Copied"),
      () => toast("Clipboard refused")
    );
  }

  /** Prefer whatever the user has highlighted inside this message — turning
   *  one paragraph into cards is far more common than turning a whole essay
   *  into cards. */
  function selectedOrAll(): string {
    const sel = window.getSelection();
    const text = sel?.toString().trim();
    if (text && text.length > 20 && bodyRef.current && sel && sel.anchorNode && bodyRef.current.contains(sel.anchorNode)) {
      return text;
    }
    return markdownToText(content);
  }

  /* An assistant turn with no variants yet and nothing streaming is a request
     that failed before producing anything — the error replaces the reply,
     because there is no reply.

     A turn that has *both* a variant and an error is the other shape: the
     stream died part-way, and what arrived before it broke is kept. That one
     renders the reply and says underneath that it stopped early, because four
     paragraphs of a five-paragraph answer are worth reading and used to be
     replaced by a red box. */
  const failed = !isUser && !streaming && turn.variants.length === 0;
  const cutShort = !isUser && !streaming && !!turn.error && turn.variants.length > 0;

  return (
    <div
      className={`turn ${isUser ? "user" : "assistant"}${turn.starred ? " starred" : ""}${listening ? " listening" : ""}`}
      data-turn={turn.id}
    >
      <div className="turn-head">
        <span>{isUser ? "You" : "Assistant"}</span>
        {turn.starred && <Icon name="star-filled" size={11} style={{ color: "var(--amber)" }} />}
        {turn.variants.length > 1 && (
          <span className="variant-nav">
            <button onClick={() => onVariant(turn.active - 1)} disabled={turn.active === 0} aria-label="Previous version">
              ‹
            </button>
            {turn.active + 1}/{turn.variants.length}
            <button
              onClick={() => onVariant(turn.active + 1)}
              disabled={turn.active >= turn.variants.length - 1}
              aria-label="Next version"
            >
              ›
            </button>
          </span>
        )}
      </div>

      {!!turn.attachments?.length && (
        <div className="att-row">
          {turn.attachments.map((a) => (
            <AttachmentCard key={a.id} a={a} onOpen={onOpenAttachment ? () => onOpenAttachment(a) : undefined} />
          ))}
        </div>
      )}

      {hasToc && !editing && (
        <nav className={"turn-toc" + (tocOpen ? " open" : "")}>
          <button className="turn-toc-head" onClick={() => setTocOpen((v) => !v)} aria-expanded={tocOpen}>
            <Icon name="chevron" size={11} className="turn-toc-chev" />
            <span>Contents</span>
            <span className="turn-toc-meta">
              {outline!.heads.length} sections · {outline!.words.toLocaleString()} words · {outline!.minutes} min
            </span>
          </button>
          {tocOpen && (
            <ol className="turn-toc-list">
              {outline!.heads.map((h, i) => (
                <li key={i} data-level={h.level}>
                  <button onClick={() => jump(i)}>
                    <span className="n">{i + 1}</span>
                    <span className="t">{h.text}</span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </nav>
      )}

      {editing ? (
        <div className="composer-box" style={{ marginBottom: 8 }}>
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                commitEdit();
              }
              if (e.key === "Escape") setEditing(false);
            }}
            style={{ minHeight: 90 }}
          />
          <div className="composer-bar">
            <span className="composer-hint" style={{ margin: 0 }}>
              replaces everything after this message
            </span>
            <button className="cbtn ghost" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button className="csend" onClick={commitEdit}>
              Send
            </button>
          </div>
        </div>
      ) : failed ? (
        <div className="chat-err">
          <span style={{ flex: 1 }}>{turn.error || "That request failed."}</span>
          <button onClick={onRetry}>Retry</button>
        </div>
      ) : isUser ? (
        <div className="turn-body">{content}</div>
      ) : (
        <div className="turn-body" ref={bodyRef}>
          {/* First of the three, because it is first in time: the model
              thought, then it looked things up, then it answered. In agent
              mode the live chain belongs on the step that produced it and the
              trace renders it there, so this one stands down. */}
          {thinking && !agentLive ? (
            <ThinkingPanel
              text={thinking.text}
              running={thinking.endedAt == null && (!!thinking.text || thinking.asked)}
              since={thinking.startedAt}
              ms={thinking.endedAt != null ? thinking.endedAt - thinking.startedAt : undefined}
            />
          ) : !streaming && variant?.reasoning ? (
            <ThinkingPanel text={variant.reasoning} ms={variant.reasoningMs} tokens={variant.usage?.reasoningTokens} />
          ) : !streaming && variant?.reasoningMs ? (
            /* It thought and published nothing. The panel says so rather than
               showing an empty disclosure, which would read as a bug. */
            <ThinkingPanel text="" ms={variant.reasoningMs} tokens={variant.usage?.reasoningTokens} />
          ) : null}
          {/* Above the reply, because it happened before it — and because a
              collapsed one-line summary reads as provenance, which is what it
              is, rather than as an appendix nobody opens. */}
          {agentLive && (agentLive.steps.length || agentLive.plan) ? (
            <AgentTrace
              steps={agentLive.steps}
              plan={agentLive.plan}
              notes={agentLive.notes}
              running={!agentLive.answering}
            />
          ) : !streaming && variant?.trace && (variant.trace.steps.length || variant.trace.plan) ? (
            <AgentTrace
              steps={stepsFromTrace(variant.trace.steps)}
              plan={variant.trace.plan}
              notes={variant.trace.notes}
              unfinished={variant.trace.unfinished}
              truncated={variant.trace.truncated}
              totalMs={variant.trace.totalMs}
            />
          ) : null}
          <span className="turn-md" ref={mdRef} dangerouslySetInnerHTML={{ __html: html }} />
          {slots.map((slot) => {
            const at = Number(slot.dataset.vis);
            const block = rendered.visuals[at];
            if (!block) return null;
            /* Into the slot, not around it: the figure is a React subtree
               mounted inside markup React does not own, which is the only way
               a live chart can sit in the middle of rendered markdown. */
            return createPortal(
              <ErrorGuard fallback={<div className="vis-error">This figure could not be shown.</div>}>
                <Visual
                  block={block}
                  history={block.kind === "canvas" ? canvases?.get(canvasId(block.info)) : undefined}
                  keep={{ projectId: conversation.projectId, conversationId: conversation.id, conversationTitle: conversation.title }}
                  onAskFix={busy ? undefined : onAskFix}
                  onMakeCards={onMakeCards}
                  onOpenBoard={onOpenBoard}
                />
              </ErrorGuard>,
              slot,
              `vis-${at}`
            );
          })}
          {streaming && <span className="caret" />}
          {/* A picture arrives whole, at the end, long after the words have
              stopped — and an image model asked for a picture often writes no
              words at all. Without this the reply is a blank bubble with a
              caret in it for twenty seconds, which reads as a hang rather than
              as work. Shown only when a picture was actually asked for. */}
          {streaming && conversation.actions?.includes("image") && (
            <div className="photo-pending">Drawing…</div>
          )}
          {/* Under the words, because the words are usually about the picture.
              Never while streaming: the reply arrives before the pictures are
              in the file store, and a frame that pointed at bytes not yet
              written would draw the "not in this browser" sentence. */}
          {!streaming &&
            variant?.images?.map((img) => (
              <ErrorGuard key={img.id} fallback={<div className="vis-error">This picture could not be shown.</div>}>
                <Picture
                  image={img}
                  keep={{ projectId: conversation.projectId, conversationId: conversation.id, conversationTitle: conversation.title }}
                  onMakeCards={onMakeCards}
                />
              </ErrorGuard>
            ))}
          {!streaming && variant?.citations?.length ? <Sources citations={variant.citations} /> : null}
          {!streaming && variant?.saved && <MemorySaved saved={variant.saved} />}
        </div>
      )}

      {!editing && !streaming && !failed && (
        <div className={`turn-acts${isLast || listening ? " always" : ""}`}>
          {!isUser && <ListenButton turn={turn} conversation={conversation} content={content} root={mdRef} />}
          <button className="tact" onClick={copyAll} title="Copy response">
            <Icon name="copy" size={11} />
            <span>Copy</span>
          </button>
          {isUser ? (
            <button className="tact" onClick={beginEdit} disabled={busy} title="Edit message">
              <Icon name="pencil" size={11} />
              <span>Edit</span>
            </button>
          ) : (
            <>
              <RegenerateMenu
                backend={conversation.backend}
                currentModel={variant?.model || AI.resolve({ backend: conversation.backend, model: conversation.model }).model}
                busy={busy}
                onRegenerate={onRegenerate}
              />
              <button className="tact" onClick={() => onMakeCards(selectedOrAll())} disabled={busy} title="Turn into flashcards">
                <Icon name="cards" size={11} />
                <span>Make cards</span>
              </button>
              <button className="tact" onClick={() => onSaveNote(selectedOrAll())} title="Save to insight log">
                <Icon name="journal" size={11} />
                <span>Save insight</span>
              </button>
            </>
          )}
          <button className="tact" onClick={onBranch} title="Branch into a new conversation">
            <Icon name="panel" size={11} />
            <span>Branch</span>
          </button>
          <button className={"tact" + (turn.starred ? " on" : "")} onClick={onStar} title={turn.starred ? "Unstar turn" : "Star turn"}>
            <Icon name={turn.starred ? "star-filled" : "star"} size={11} />
          </button>
          <button className="tact danger" onClick={onDelete} title="Delete message">
            <Icon name="close" size={11} />
          </button>
        </div>
      )}

      {cutShort && (
        <div className="chat-err cut-short">
          <span style={{ flex: 1 }}>Cut short — {turn.error}</span>
          <button onClick={onRetry}>Retry</button>
        </div>
      )}

      {!isUser && !streaming && variant && (variant.usage || variant.elapsed || variant.listened) && (
        <div className="turn-foot">
          {variant.model ? variant.model + " · " : ""}
          {variant.elapsed ? (variant.elapsed / 1000).toFixed(1) + "s" : ""}
          {variant.usage
            ? ` · ${formatTokens(variant.usage.promptTokens)} in / ${formatTokens(variant.usage.completionTokens)} out`
            : ""}
          {/* The receipt for the Think switch. Reasoning is billed as output
              and is invisible in the reply, so without this the only evidence
              that thinking happened is the bill being larger than it looks. */}
          {variant.usage?.reasoningTokens ? ` (${formatTokens(variant.usage.reasoningTokens)} thinking)` : ""}
          {variant.usage?.cost != null ? " · " + formatCost(variant.usage.cost) : ""}
          {/* What hearing it cost, beside what writing it cost. An unpriced
              voice shows what was read rather than a cost it cannot know. */}
          {variant.listened
            ? ` · listened ${variant.listened.cost != null ? formatCost(variant.listened.cost) : formatTokens(variant.listened.chars) + " characters"}`
            : ""}
        </div>
      )}
    </div>
  );
}
