/* ============================================================================
 * ChatView — the chat platform's shell: sidebar, transcript, composer, and
 * the surfaces that hang off them (command palette, card maker).
 *
 * Owns the slash commands and palette actions, because those are the places
 * where chat reaches into the drill half of the app and it is worth having
 * that wiring in one readable list rather than scattered through components.
 * ========================================================================== */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import * as chatStore from "@/services/chatStore";
import * as store from "@/services/store";
import * as AI from "@/services/ai";
import * as memoryCapture from "@/services/memoryCapture";
import * as memoryStore from "@/services/memoryStore";
import * as boards from "@/services/boards";
import { poolFor } from "@/lib/memoryBrief";
import { parseRememberArg, wrapUpWindow } from "@/lib/rememberArg";
import { conceptMap, mappable } from "@/lib/visuals/conceptMap";
import { gapsFrom } from "@/lib/gaps";
import type { ChatMessage } from "@/types";
import type { Attachment } from "@/types/chat";
import { catalogueEntry, loadPricing } from "@/services/pricing";
import { canTake, imageWarning, scannedWarning } from "@/lib/modality";
import { resolveBackend, resolveModel } from "@/lib/resolveSetting";
import { useChat } from "@/context/ChatContext";
import { useRoute } from "@/context/RouteContext";
import { useSettings } from "@/context/SettingsContext";
import { useToast } from "@/context/ToastContext";
import { useDrillStore } from "@/hooks/useDrillStore";
import { describeSource } from "@/lib/chatContext";
import { catalogue } from "@/lib/references";
import { markdownToText } from "@/lib/markdown";
import { ASK_ABOUT_TODAY } from "@/lib/dayBrief";
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
import ImageComposer from "./ImageComposer";
import ListenBar from "./ListenBar";
import ErrorGuard from "../ui/ErrorGuard";
import AttachmentPreview from "./AttachmentPreview";

/* Excalidraw and its stylesheet are about half a megabyte for a surface most
   sessions never open, so the whiteboard arrives only when one is asked for. */
const BoardSheet = lazy(() => import("../visuals/BoardSheet"));

/* Imported here rather than in main.tsx so both stylesheets ride along with
   the lazy chat chunk instead of blocking the review loop's first paint. */
import "@/styles/chat.css";
/* The figure frame, which the Figures section draws with too — that is why it
   is not in chat.css any more. */
import "@/styles/figures.css";
import "katex/dist/katex.min.css";

/** How much of a conversation one bare /remember reads — about twelve thousand
 *  tokens, well inside any model worth extracting memory with. A longer thread
 *  is read in more than one pass rather than refused. */
const MAX_REMEMBER_CHARS = 48_000;
/** And of any one turn, so a pasted paper does not spend the whole budget. */
const MAX_REMEMBER_TURN_CHARS = 12_000;

/** A drag carrying files, as opposed to text or a link being dragged about. */
function carriesFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types || []).includes("Files");
}

export default function ChatView() {
  const chat = useChat();
  const { conversationId, openDrill, openFigures } = useRoute();
  const toast = useToast();
  /* Chat had its own settings drawer — a second navigation over the same
     settings, with a scope tab strip the sidebar's panel did not have. It
     opens the one panel now, on this thread's own page. */
  const settings = useSettings();
  useDrillStore(); // deck/note changes should refresh context labels

  const [palette, setPalette] = useState(false);
  const [cardSource, setCardSource] = useState<string | null>(null);
  const [seed, setSeed] = useState<{ text: string; nonce: number } | null>(null);
  /* Files dropped anywhere on the column — the whole column rather than the
     text box, because the text box at rest is one line tall and aiming a file
     at it is a skill. They wait in a queue the composer empties, and a nonce
     tells it to look; see Composer's `takeDropped` for why not a prop. */
  const dropQueue = useRef<File[]>([]);
  const [dropNonce, setDropNonce] = useState(0);
  const takeDropped = useCallback(() => {
    const files = dropQueue.current;
    dropQueue.current = [];
    return files;
  }, []);
  const [dragging, setDragging] = useState(false);
  /* dragenter and dragleave fire for every child crossed on the way in and
     out; a count is what tells leaving the column from moving within it. */
  const dragDepth = useRef(0);
  const [preview, setPreview] = useState<Attachment | null>(null);
  const [board, setBoard] = useState<boards.StoredBoard | null>(null);

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

  /* The model catalogue is fetched once and memoised, and it lands a second or
     two after the first paint. Nothing else on this screen would think to
     re-render when it does, so every attach row would read as "not known" for
     the rest of the session. ToolsMenu solves the same problem the same way. */
  const [catalogueVersion, bumpCatalogue] = useState(0);
  useEffect(() => {
    let live = true;
    void loadPricing().then(() => live && bumpCatalogue((n) => n + 1));
    return () => {
      live = false;
    };
  }, []);

  /* The model that will actually answer: the conversation's own, inherited
     through its project, or the one picked on the empty screen. The same
     lookup the send path makes, so nothing the composer says can promise what
     the request does not do.

     Recomputed when the pricing catalogue lands as well as when the model
     changes — it arrives a second or two after the first paint, and without
     that every row would read "unknown" until something else re-rendered. */
  const target = useMemo(
    () => {
      const project = c ? store.get().projects[c.projectId] : undefined;
      return c
        ? AI.resolve({ backend: resolveBackend(c, project).value, model: resolveModel(c, project).value })
        : AI.resolve(chat.draftModel ? { model: chat.draftModel } : undefined);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [c, chat.draftModel, catalogueVersion]
  );

  /* What that model can take, for the attach menu. Three states, and the
     third leaves the row live: lib/modality.ts's rule, because a local model
     has no catalogue entry and greying a row out for everyone until the
     catalogue loads is a worse answer than a picture that gets ignored. */
  const attachVerdicts = useMemo(() => {
    const modalities = catalogueEntry(target.model)?.inputModalities;
    return { image: canTake(modalities, "image"), file: canTake(modalities, "file") };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.model, catalogueVersion]);

  const attachReasons = useMemo(
    () => ({ image: imageWarning(target.model, attachVerdicts.image) || "" }),
    [target.model, attachVerdicts.image]
  );

  const warnFor = useCallback(
    (a: Attachment): string | null => {
      const image = attachVerdicts.image;
      if (a.kind === "image") return imageWarning(target.model, image);
      if (a.kind === "pdf") {
        const mode = c ? c.mode || "direct" : chat.draftMode;
        const engine = mode === "direct" ? store.settings().pdfEngine || "local" : "local";
        return scannedWarning(target.model, image, a.scanned?.length || 0, engine, target.type);
      }
      return null;
    },
    [c, chat.draftMode, target, attachVerdicts.image]
  );

  /* --------------------------------------------------------- whiteboard -- */

  /** Open a board: empty, or with a diagram from a reply converted into shapes
   *  you can move. The conversion is the library's own, so a diagram type it
   *  cannot lay out comes in as a picture rather than failing. */
  const openBoard = useCallback(
    async (from?: { mermaid?: string; title?: string }) => {
      const projectId = store.get().activeProjectId;
      try {
        const scene = from?.mermaid ? await boards.fromMermaid(from.mermaid) : undefined;
        const made = boards.newBoard({
          projectId,
          conversationId: c?.id,
          title: from?.title || "Whiteboard",
          scene
        });
        await boards.save(made);
        setBoard(made);
      } catch (e) {
        toast(`The whiteboard could not open — ${String((e as Error)?.message || e)}`, 8000);
      }
    },
    [c, toast]
  );

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
        cmd: "/board",
        desc: "Open a whiteboard you can draw on, and send back",
        run: (arg: string) => void openBoard(arg.trim() ? { title: arg.trim().slice(0, 60) } : undefined)
      },
      {
        cmd: "/map",
        desc: "A mind map of what this project knows and keeps getting wrong",
        run: () => {
          /* Built here from memories and the review log — no request, so this
             works with no key at all. It lands as a reply so it is drawn by
             the figure renderer, can be opened in the whiteboard, and stays in
             the conversation as something to talk about. */
          const projectId = store.get().activeProjectId;
          const project = store.get().projects[projectId];
          const topics = memoryStore.topics({ projectId }).slice(0, 8);
          const input = {
            project: project?.name || "This project",
            topics: topics.map((t) => ({
              topic: t.topic,
              items: memoryStore
                .list({ projectId, activeOnly: true })
                .filter((m) => m.topic === t.topic)
                .slice(0, 6)
                .map((m) => m.text)
            })),
            loose: memoryStore
              .list({ projectId, activeOnly: true })
              .filter((m) => !m.topic)
              .slice(0, 6)
              .map((m) => m.text),
            gaps: gapsFrom(store.logOf(store.decksOf(projectId)), { limit: 6 }).map((g) => g.text)
          };
          if (!mappable(input)) {
            toast("Nothing to map yet — memories and review history are what it draws");
            return;
          }
          const body = `Here is what this project holds so far.

\`\`\`mermaid
${conceptMap(input)}
\`\`\`

It is built from your memories and what the review loop says you keep getting wrong, so nothing was asked of a model.`;
          const target = c || chat.newConversation({ title: "Concept map" });
          if (target) chatStore.addTurn(target, chatStore.makeTurn("assistant", body));
        }
      },
      {
        cmd: "/today",
        desc: "What you have done today, and what to do next",
        run: (arg: string) => {
          chat.newConversation(
            { title: "Today", personaId: "tutor" },
            arg ? `${ASK_ABOUT_TODAY} Focus on ${arg}.` : ASK_ABOUT_TODAY
          );
        }
      },
      {
        cmd: "/figures",
        desc: "The figures and whiteboards you have kept",
        run: () => openFigures(null)
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
    [c, chat, saveNote, exportConversation, toast, settings, rememberFact, rememberConversation, openBoard, openFigures]
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

  /* Which surface the composer slot holds. Reads the conversation once one
     exists and the draft before then, the same inheritance every control in
     the composer follows. */
  const drawing = (c ? c.mode : chat.draftMode) === "image";

  return (
    /* The conversation index is passed to the shared sidebar rather than
       rendered as a second one. Chat used to carry its own 268px pane, its
       own navigation, its own project switcher and its own settings surface,
       none of which agreed with the rest of the app; what is left below is
       only the conversation itself. */
    <Shell current="chat" sidebar={<ChatSidebar onNew={newChat} />} aside={<ChatRail conversation={c} />} asideLabel="Context">
      <div
        className="chat-main"
        onDragEnter={(e) => {
          if (!carriesFiles(e)) return;
          e.preventDefault();
          dragDepth.current++;
          setDragging(true);
        }}
        onDragOver={(e) => {
          if (carriesFiles(e)) e.preventDefault();
        }}
        onDragLeave={(e) => {
          if (!carriesFiles(e)) return;
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (!dragDepth.current) setDragging(false);
        }}
        onDrop={(e) => {
          if (!carriesFiles(e)) return;
          e.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          if (!readiness.ok) {
            toast(readiness.why || "Set up a model first");
            return;
          }
          dropQueue.current.push(...Array.from(e.dataTransfer.files));
          setDropNonce((n) => n + 1);
        }}
      >
        {dragging && (
          <div className="chat-drop" aria-hidden="true">
            <span>Drop to attach — pictures, PDFs, Word, Excel, text and code</span>
          </div>
        )}
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

        {c && c.pinnedAttachments.length > 0 && (
          <div className="ctxbar">
            <span className="lbl">Pinned</span>
            {c.pinnedAttachments.map((a) => (
              <span key={a.id} className="ctxchip pinchip">
                <button className="pinchip-name" onClick={() => setPreview(a)} title="Preview">
                  {a.name}
                </button>
                <button
                  onClick={() => chat.update({ pinnedAttachments: c.pinnedAttachments.filter((x) => x.id !== a.id) })}
                  aria-label={`Unpin ${a.name}`}
                  title="Unpin — stop sending this with every message"
                >
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
          /* The chat welcome is chat's: its starters are questions, and
             offering "What should I revise today?" above a surface whose only
             verb is Draw is the mixing this mode exists to undo. Nested inside
             the empty branch rather than wrapping it — hoisted out, the same
             test swallowed the transcript itself the moment the thread had a
             picture in it. Kept when the app is not ready, because that panel
             is also where "no key yet" is said. */
          drawing && readiness.ok ? null : (
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
          )
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
                  thinking={chat.streamingTurnId === t.id ? chat.thinking : null}
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
                  onOpenAttachment={setPreview}
                  onAskFix={(message) => void chat.send(message)}
                  onOpenBoard={(from) => void openBoard(from)}
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

        {/* Image mode swaps the composer out rather than decorating it. The
            two share the send path and nothing else: slash commands,
            @-references, follow-up seeding and the drop queue are chat things,
            and a drawing surface carrying all of them was the "very mixed into
            chat" this replaced. Keyed the same way, so the remount when the
            first message creates a conversation still clears the draft rather
            than leaking it into the new thread. */}
        {drawing ? (
          <ImageComposer
            key={(conversationId || "new") + ":img"}
            disabled={!readiness.ok}
            busy={chat.busy}
            droppedNonce={dropNonce}
            takeDropped={takeDropped}
            onSend={(text, attachments) => void chat.send(text, attachments)}
            onStop={chat.stop}
          />
        ) : (
        <Composer
          key={conversationId || "new"}
          disabled={!readiness.ok}
          busy={chat.busy}
          commands={commands}
          references={references}
          tools={<ToolsMenu />}
          trailing={<ModelChip conversation={c} draftModel={chat.draftModel} onDraftModel={chat.setDraftModel} />}
          seed={seed}
          droppedNonce={dropNonce}
          takeDropped={takeDropped}
          warnFor={warnFor}
          attachVerdicts={attachVerdicts}
          attachReasons={attachReasons}
          onPreview={setPreview}
          placeholder={readiness.ok ? "Ask anything — / for commands" : readiness.why}
          onSend={(text, attachments) => void chat.send(text, attachments)}
          onStop={chat.stop}
        />
        )}
      </div>

      {palette && <CommandPalette actions={paletteActions} onClose={() => setPalette(false)} />}
      {cardSource && <CardsModal source={cardSource} onClose={() => setCardSource(null)} />}
      {preview && <AttachmentPreview a={preview} onClose={() => setPreview(null)} onMakeCards={(t) => setCardSource(t)} />}
      {board && (
        <ErrorGuard>
          <Suspense fallback={<div className="sheet" />}>
            <BoardSheet
              board={board}
              onSend={(text, attachments) => void chat.send(text, attachments)}
              onClose={() => setBoard(null)}
            />
          </Suspense>
        </ErrorGuard>
      )}
    </Shell>
  );
}
