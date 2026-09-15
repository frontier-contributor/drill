/* ============================================================================
 * ChatView — the chat platform's shell: sidebar, transcript, composer, and
 * the surfaces that hang off them (command palette, card maker).
 *
 * Owns the slash commands and palette actions, because those are the places
 * where chat reaches into the drill half of the app and it is worth having
 * that wiring in one readable list rather than scattered through components.
 * ========================================================================== */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as chatStore from "@/services/chatStore";
import * as store from "@/services/store";
import * as AI from "@/services/ai";
import * as memoryCapture from "@/services/memoryCapture";
import { poolFor } from "@/lib/memoryBrief";
import { parseRememberArg, wrapUpWindow } from "@/lib/rememberArg";
import type { ChatMessage } from "@/types";
import { useChat } from "@/context/ChatContext";
import { useRoute } from "@/context/RouteContext";
import { useSettings } from "@/context/SettingsContext";
import { useToast } from "@/context/ToastContext";
import { useDrillStore } from "@/hooks/useDrillStore";
import { describeSource } from "@/lib/chatContext";
import { catalogue } from "@/lib/references";
import { markdownToText } from "@/lib/markdown";
import { estimateTurnTokens, formatCost, formatTokens } from "@/lib/tokens";
import { getPersona } from "@/lib/personas";
import { download, slug } from "@/lib/util";
import Shell from "../Shell";
import ChatRail from "../rail/ChatRail";
import Icon from "../ui/Icon";
import ChatSidebar from "./ChatSidebar";
import MessageTurn from "./MessageTurn";
import Composer, { type SlashCommand } from "./Composer";
import CommandPalette, { type PaletteAction } from "./CommandPalette";
import CardsModal from "./CardsModal";
import ChatEmpty from "./ChatEmpty";
import ReadProgress from "./ReadProgress";
import ModelChip from "./ModelChip";
import ToolsMenu from "./ToolsMenu";
import ListenBar from "./ListenBar";
import ErrorGuard from "../ui/ErrorGuard";

/* Imported here rather than in main.tsx so both stylesheets ride along with
   the lazy chat chunk instead of blocking the review loop's first paint. */
import "@/styles/chat.css";
import "katex/dist/katex.min.css";

/** How much of a conversation one bare /remember reads — about twelve thousand
 *  tokens, well inside any model worth extracting memory with. A longer thread
 *  is read in more than one pass rather than refused. */
const MAX_REMEMBER_CHARS = 48_000;
/** And of any one turn, so a pasted paper does not spend the whole budget. */
const MAX_REMEMBER_TURN_CHARS = 12_000;

export default function ChatView() {
  const chat = useChat();
  const { conversationId, openDrill } = useRoute();
  const toast = useToast();
  /* Chat had its own settings drawer — a second navigation over the same
     settings, with a scope tab strip the sidebar's panel did not have. It
     opens the one panel now, on this thread's own page. */
  const settings = useSettings();
  useDrillStore(); // deck/note changes should refresh context labels

  const [palette, setPalette] = useState(false);
  const [cardSource, setCardSource] = useState<string | null>(null);
  const [seed, setSeed] = useState<{ text: string; nonce: number } | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedToBottom = useRef(true);

  const c = chat.conversation;

  /* Rebuilt whenever the stores change, which is what useDrillStore above is
     for — a journal entry written a minute ago has to be referenceable now,
     not after a reload. Cheap: every `text` in it is a thunk. */
  const references = useMemo(
    () => catalogue(c?.projectId || store.get().activeProjectId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [c?.projectId, store.getVersion()]
  );

  useEffect(() => {
    void chatStore.init();
  }, []);

  /* Follow the stream only while the reader is already at the bottom —
     yanking the viewport while someone is reading further up is the single
     most irritating thing a chat UI can do.

     How far through the thread you are is ReadProgress' job, and it watches
     this same element itself. */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
    // turns.length, not just the id: a conversation opened straight from its
    // URL renders once with nothing loaded, and an empty one renders ChatEmpty
    // instead, so on that first pass there is no scroll container to listen to
    // and the id alone would never bring the effect back.
  }, [conversationId, c?.turns.length]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedToBottom.current) el.scrollTop = el.scrollHeight;
  }, [chat.streaming, c?.turns.length, conversationId]);

  /* ---------------------------------------------------------- shortcuts -- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((v) => !v);
      } else if (mod && e.key.toLowerCase() === "j") {
        e.preventDefault();
        newChat();
      } else if (e.key === "Escape") {
        /* Settings is not handled here. It is one surface for the whole app
           now, and Shell — which mounts it — owns its Escape, so closing it
           from chat must not also clear the message you were writing. */
        if (palette) setPalette(false);
        else if (cardSource) setCardSource(null);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [palette, cardSource]); // eslint-disable-line react-hooks/exhaustive-deps

  const newChat = useCallback(() => chat.newConversation(), [chat]);

  /* ------------------------------------------------------------ actions -- */

  const saveNote = useCallback(
    (text: string) => {
      const clean = markdownToText(text).slice(0, 4000);
      if (!clean) return;
      store.addNote(clean, c?.titled ? c.title : "chat");
      toast("Saved to the insight log");
    },
    [c, toast]
  );

  const exportConversation = useCallback(() => {
    if (!c) return;
    download(slug(c.title) + ".md", chatStore.toMarkdown(c), "text/markdown");
    toast("Exported");
  }, [c, toast]);

  /** Set while a bare /remember is reading, so a second one cannot start a
   *  second extraction over the same turns and save everything twice. A ref,
   *  because the guard has to hold between two presses inside one render. */
  const remembering = useRef(false);

  /** Hang a save's outcome on the newest reply, so it renders inline the same
   *  way the natural-language path's receipt does. With no reply to hang it
   *  on, the toast is the whole receipt. */
  const hangReceipt = useCallback(
    (result: memoryCapture.CaptureResult) => {
      if (!c) return;
      const target = [...c.turns].reverse().find((t) => t.role === "assistant" && t.variants.length);
      if (!target) return;
      const v = target.variants[target.active];
      v.saved = memoryCapture.merge(v.saved, memoryCapture.summarise(result));
    },
    [c]
  );

  /**
   * `/remember <fact>` — the learner's own sentence, saved as they wrote it.
   *
   * No request, and no conversation needed: this is the one save that works on
   * the empty chat screen. It used to discard the sentence and run the
   * extraction below instead. See lib/rememberArg.ts.
   */
  const rememberFact = useCallback(
    (arg: string) => {
      const fact = parseRememberArg(arg);
      if (!fact) {
        toast("Write the fact after the command — /remember I prefer the intuition before the formula", 6000);
        return;
      }
      const lastTurn = c?.turns[c.turns.length - 1];
      const result = memoryCapture.capture(
        [{ ...fact, stated: true }],
        c ? { conversationId: c.id, turnId: lastTurn?.id || "" } : null
      );
      memoryCapture.logToJournal(result, "Saved from chat");
      if (c) {
        hangReceipt(result);
        chatStore.persist(c, true);
      }
      toast(memoryCapture.describe(result), 5000);
    },
    [c, toast, hangReceipt]
  );

  /**
   * Bare `/remember` — the deliberate save. Unlike the natural-language path,
   * which rides along in a normal reply for free, this is its own extraction
   * pass, so it fires whether or not the model noticed you asking.
   *
   * Reads forward from `rolledUpThrough`, up to a budget, and moves the marker
   * only as far as it actually read — so running it twice never re-mines a turn
   * and a long thread is finished in a second pass rather than refused.
   */
  const rememberConversation = useCallback(async () => {
    if (!c || !c.turns.length) {
      toast("Nothing to read yet. To save one thing directly, write it after the command: /remember …", 6000);
      return;
    }
    if (remembering.current) {
      toast("Still reading this conversation");
      return;
    }
    const from = Math.min(c.rolledUpThrough || 0, c.turns.length);
    if (from >= c.turns.length) {
      toast("Nothing new since the last save");
      return;
    }

    const texts = c.turns.map((t) =>
      t.variants.length ? markdownToText(chatStore.activeContent(t)).slice(0, MAX_REMEMBER_TURN_CHARS) : ""
    );
    const { end } = wrapUpWindow(
      texts.map((s) => s.length),
      from,
      MAX_REMEMBER_CHARS
    );
    const msgs = c.turns
      .slice(from, end)
      .map((t, i) => ({ role: t.role, content: texts[from + i] }) as ChatMessage)
      .filter((m) => m.content.trim());
    const rest = end < c.turns.length ? " · run /remember again for the rest" : "";

    remembering.current = true;
    toast("Reading the conversation…", 60_000);
    try {
      const known = poolFor("both", c.projectId).map((m) => m.text);
      const items = msgs.length ? await AI.wrapUp(msgs, known) : [];

      if (!items.length) {
        c.rolledUpThrough = end;
        chatStore.persist(c, true);
        toast("Nothing durable worth keeping — memory left alone" + rest, 5000);
        return;
      }

      const result = memoryCapture.capture(items, { conversationId: c.id, turnId: c.turns[end - 1]?.id || "" });
      memoryCapture.logToJournal(result, "Saved from chat");
      hangReceipt(result);
      c.rolledUpThrough = end;
      chatStore.persist(c, true);
      toast(memoryCapture.describe(result) + rest, 6000);
    } catch (e) {
      toast((e as Error).message || "Could not read the conversation", 9000);
    } finally {
      remembering.current = false;
    }
  }, [c, toast, hangReceipt]);

  /* ----------------------------------------------------- slash commands -- */

  const commands: SlashCommand[] = useMemo(
    () => [
      {
        cmd: "/cards",
        desc: "Turn the last reply into flashcards",
        run: () => {
          const last = [...(c?.turns || [])].reverse().find((t) => t.role === "assistant" && t.variants.length);
          if (!last) {
            toast("Nothing to make cards from yet");
            return;
          }
          setCardSource(markdownToText(chatStore.activeContent(last)));
        }
      },
      {
        cmd: "/quiz",
        desc: "Get quizzed on what is due right now",
        run: (arg: string) => {
          /* Scoped to the project, matching the { kind: "due" } source this
             is about to attach — the guard and the attachment have to agree
             or /quiz refuses on a project that has plenty due. */
          const counts = store.counts(store.decksOf(store.get().activeProjectId));
          if (!counts.due && !counts.newLeft) {
            toast("Nothing due — try /weak instead");
            return;
          }
          chat.newConversation(
            {
              title: "Quiz session",
              personaId: "socratic",
              context: [{ kind: "due", deckId: null }]
            },
            "Quiz me on the cards that are due right now" +
              (arg ? `, focusing on ${arg}` : "") +
              ". Ask one question at a time, wait for my answer, then tell me what I missed before moving on. " +
              "Do not show me the card's answer until I have attempted it."
          );
        }
      },
      {
        cmd: "/weak",
        desc: "Work on the cards you keep failing",
        run: (arg: string) => {
          chat.newConversation(
            {
              title: "Weak spots",
              personaId: "tutor",
              context: [{ kind: "weak", deckId: null }]
            },
            "Look at the cards I keep failing" +
              (arg ? ` related to ${arg}` : "") +
              ". Find what they have in common — the underlying idea I have not actually understood — and teach me " +
              "that, rather than drilling the cards one by one."
          );
        }
      },
      {
        cmd: "/explain",
        desc: "Explain a topic from scratch",
        run: (arg: string) => {
          if (!arg) {
            toast("Say what to explain: /explain backprop");
            return;
          }
          chat.newConversation({ title: arg.slice(0, 60), personaId: "explain" }, `Explain ${arg} from first principles.`);
        }
      },
      {
        cmd: "/feynman",
        desc: "You explain it, the model finds the holes",
        run: (arg: string) => {
          chat.newConversation(
            { title: arg ? `Feynman: ${arg.slice(0, 40)}` : "Feynman check", personaId: "feynman" },
            arg ? `I am going to explain ${arg} to you. Ask me to begin.` : "I am going to explain something to you. Ask me what."
          );
        }
      },
      {
        cmd: "/deck",
        desc: "Attach a deck as context",
        run: () => {
          settings.open("conversation");
          toast("Pick a deck under “Attach a whole deck”");
        }
      },
      {
        cmd: "/note",
        desc: "Save the last reply to the insight log",
        run: () => {
          const last = [...(c?.turns || [])].reverse().find((t) => t.role === "assistant" && t.variants.length);
          if (!last) {
            toast("Nothing to save yet");
            return;
          }
          saveNote(chatStore.activeContent(last));
        }
      },
      {
        cmd: "/remember",
        desc: "Save the fact you write after it — or, alone, what this conversation is worth keeping",
        run: (arg: string) => (arg.trim() ? rememberFact(arg) : void rememberConversation())
      },
      {
        cmd: "/export",
        desc: "Download this conversation as markdown",
        run: exportConversation
      },
      {
        cmd: "/settings",
        desc: "Model, mode, temperature, context",
        run: () => settings.open("conversation")
      }
    ],
    [c, chat, saveNote, exportConversation, toast, settings, rememberFact, rememberConversation]
  );

  /* --------------------------------------------------- palette actions -- */

  const paletteActions: PaletteAction[] = useMemo(
    () => [
      { id: "new", label: "New chat", hint: "ctrl+J", run: newChat },
      { id: "drill", label: "Go to the review loop", hint: "view", run: openDrill },
      { id: "settings", label: "Conversation settings", hint: "action", run: () => settings.open("conversation") },
      { id: "export", label: "Export this conversation", hint: "action", run: exportConversation },
      ...commands.map((cm) => ({ id: cm.cmd, label: cm.desc, hint: cm.cmd, run: () => cm.run("") }))
    ],
    [newChat, openDrill, exportConversation, commands, settings]
  );

  /* -------------------------------------------------------------- render -- */

  const resolved = c ? AI.resolve({ backend: c.backend, model: c.model }) : AI.resolve();
  const readiness = AI.ready(c ? { backend: c.backend, model: c.model } : undefined);
  const contextTokens = c ? estimateTurnTokens(c.turns) : 0;

  return (
    /* The conversation index is passed to the shared sidebar rather than
       rendered as a second one. Chat used to carry its own 268px pane, its
       own navigation, its own project switcher and its own settings surface,
       none of which agreed with the rest of the app; what is left below is
       only the conversation itself. */
    <Shell current="chat" sidebar={<ChatSidebar onNew={newChat} />} aside={<ChatRail conversation={c} />} asideLabel="Context">
      <div className="chat-main">
        <div className="chat-head">
          {c ? (
            <>
              <button
                className="chat-title"
                title="Rename"
                onClick={() => {
                  const n = window.prompt("Rename this conversation:", c.title);
                  if (n) chatStore.rename(c, n);
                }}
              >
                {c.title}
              </button>
              <div className="chat-meta">
                <span className="head-badge mono" title="Active model">
                  <Icon name="sparkle" size={10} />
                  {resolved.model}
                </span>
                <span className="head-badge" title="Persona">
                  <Icon name="bubble" size={10} />
                  {getPersona(c.personaId).name}
                </span>
                <span className="head-badge mono" title="Approximate tokens in context">
                  ~{formatTokens(contextTokens)} ctx
                </span>
                {c.usage.cost != null && (
                  <span className="head-badge mono" title="Estimated cost">
                    {formatCost(c.usage.cost)}
                  </span>
                )}
              </div>
              <button
                className={"chat-headbtn" + (c.pinned ? " on" : "")}
                onClick={() => chatStore.setPinned(c, !c.pinned)}
                title={c.pinned ? "Unpin" : "Pin"}
                aria-pressed={c.pinned}
              >
                <Icon name={c.pinned ? "star-filled" : "star"} size={13} />
              </button>
              <button
                className={"chat-headbtn" + (settings.cat === "conversation" ? " on" : "")}
                onClick={() => settings.open("conversation")}
                title="Conversation settings  (ctrl + ,)"
              >
                <Icon name="settings" size={13} />
                <span>Settings</span>
              </button>
            </>
          ) : (
            <>
              <span className="chat-title">New conversation</span>
              <div className="chat-meta">
                <span className="head-badge mono">{resolved.backend.label}</span>
              </div>
            </>
          )}
        </div>

        {c && c.context.length > 0 && (
          <div className="ctxbar">
            <span className="lbl">Context</span>
            {c.context.map((s, i) => (
              <span key={i} className="ctxchip">
                {describeSource(s)}
                <button onClick={() => chat.setContext(c.context.filter((_, j) => j !== i))} aria-label="Remove">
                  <Icon name="close" size={11} />
                </button>
              </span>
            ))}
          </div>
        )}

        <ReadProgress
          scrollRef={scrollRef}
          busy={chat.busy}
          resyncKey={`${conversationId || ""}:${c?.turns.length ?? 0}`}
        />

        {!c || c.turns.length === 0 ? (
          <ChatEmpty
            ready={readiness}
            onStart={(prompt, opts) => {
              if (c && c.turns.length === 0) {
                if (opts) chat.update(opts);
                void chat.send(prompt);
              } else {
                chat.newConversation(opts, prompt);
              }
            }}
            onPrefill={(text) => setSeed({ text, nonce: Date.now() })}
          />
        ) : (
          <div className="msgs" ref={scrollRef}>
            <div className="msgs-inner">
              {!readiness.ok && <div className="chat-err">{readiness.why}</div>}

              {c.turns.map((t, i) => (
                <MessageTurn
                  key={t.id}
                  turn={t}
                  isLast={i === c.turns.length - 1}
                  /* The loop as it runs, above the turn it is answering into.
                     Handed down rather than read from context inside
                     MessageTurn so exactly one turn can ever show it — the
                     one being streamed into. */
                  agentLive={chat.streamingTurnId === t.id ? chat.agentLive : null}
                  streamingText={chat.streamingTurnId === t.id ? chat.streaming : null}
                  busy={chat.busy}
                  conversation={c}
                  onRegenerate={(override) => void chat.regenerate(t.id, override)}
                  onEdit={(text) => void chat.editUserTurn(t.id, text)}
                  onBranch={() => chat.branchFrom(i)}
                  onMakeCards={(text) => setCardSource(text)}
                  onSaveNote={saveNote}
                  onVariant={(v) => {
                    chatStore.setVariant(c, t, v);
                    chat.update({});
                  }}
                  onStar={() => {
                    t.starred = !t.starred;
                    chatStore.persist(c, true);
                    chat.update({});
                  }}
                  onDelete={() => {
                    chatStore.removeTurn(c, t.id);
                    chat.update({});
                  }}
                  onRetry={() => void chat.retry()}
                />
              ))}

              {chat.followups.length > 0 && !chat.busy && (
                <div className="followups">
                  {chat.followups.map((f, i) => (
                    <button key={i} className="fchip" onClick={() => void chat.send(f)}>
                      {f}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Outside the transcript's scroll container, like the composer under
            it: what you are hearing keeps its controls in view. Guarded,
            because it renders voices and errors that came from a provider. */}
        <ErrorGuard>
          <ListenBar scrollRef={scrollRef} />
        </ErrorGuard>

        <Composer
          key={conversationId || "new"}
          disabled={!readiness.ok}
          busy={chat.busy}
          commands={commands}
          references={references}
          tools={<ToolsMenu />}
          trailing={<ModelChip conversation={c} draftModel={chat.draftModel} onDraftModel={chat.setDraftModel} />}
          seed={seed}
          placeholder={readiness.ok ? "Ask anything — / for commands" : readiness.why}
          onSend={(text, attachments) => void chat.send(text, attachments)}
          onStop={chat.stop}
        />
      </div>

      {palette && <CommandPalette actions={paletteActions} onClose={() => setPalette(false)} />}
      {cardSource && <CardsModal source={cardSource} onClose={() => setCardSource(null)} />}
    </Shell>
  );
}
