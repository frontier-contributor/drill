/* ============================================================================
 * ToolsMenu — one button, one menu, everything the next message is set to.
 *
 * This replaces four separate controls that used to sit in a row along the
 * bottom of the composer: the mode picker, the effort picker, and one chip per
 * capability. Each was defensible on its own and together they were a
 * dashboard. Five popovers competing for a bar 42rem wide is not a choice
 * architecture, it is a wall, and the cost of a wall is that people stop
 * reading it — the whole point of writing "up to 6 lookups, each one a
 * request" on the mode rows is lost if the row is never opened.
 *
 * So the composer keeps the two things you actually change mid-sentence where
 * they were — the model, and Send — and everything else moves behind one door.
 * That is the shape every mature chat tool has converged on, and the reason is
 * the same everywhere: a menu can afford a sentence per option, a chip row
 * cannot afford three words.
 *
 * The one exception is the capability switches, and they are an exception
 * because they are not choices, they are switches. A switch behind a door is
 * two clicks and a hunt for something you flip every few messages; a switch
 * on the bar is one glyph that is itself the state. So each action in the
 * registry is an icon on the bar — dim when off, lit when on — and nothing
 * else about it needs a label. That also retired the pills: a lit globe *is*
 * "Web is on", and a pill beside it saying so was the same fact twice.
 *
 * What stops the rest becoming hidden state is the button's own label. It
 * says "Tools" only while everything behind it is at its default, and names
 * the mode or the pinned effort the moment either is not. Off is quiet, on is
 * loud. Nothing is ever in force without being visible in the bar.
 *
 * Two sections, in the order the decisions are actually made:
 *
 *   How to answer   direct / agent / deep / image. Each says what it costs in
 *                   requests, because that is the real question.
 *   Effort          how much of everything one message gets.
 *
 * The model-dependent switch is new, and it is why this file asks
 * `availability()` rather than reading `backend.supports` itself. Thinking is
 * not a property of where the request goes: one OpenRouter key reaches models
 * that reason and models that do not, and the model chip is one control away.
 * So the answer is recomputed on every render from the *resolved* model, and a
 * model that cannot think leaves the switch dimmed with that model's own name
 * in the reason — on hover, and in a toast when it is pressed, because a
 * tooltip is not something a finger can reach.
 * ========================================================================== */
import { useEffect, useRef, useState } from "react";
import * as AI from "@/services/ai";
import * as store from "@/services/store";
import { loadPricing } from "@/services/pricing";
import { useChat } from "@/context/ChatContext";
import { useToast } from "@/context/ToastContext";
import { ACTION_ORDER, CHAT_ACTIONS, availability, type ChatActionId } from "@/lib/chatActions";
import { EFFORT_ORDER, budgetFor, deepSteps, effortMeans } from "@/lib/effort";
import { resolveEffort } from "@/lib/resolveSetting";
import type { ChatMode } from "@/types/chat";
import type { Effort } from "@/types/core";
import Icon, { type IconName } from "../ui/Icon";

interface ModeDef {
  id: ChatMode;
  label: string;
  icon: IconName;
  blurb: string;
  /** How many rounds of tool use, given the resolved effort. */
  steps: (agentSteps: number) => number;
}

const MODES: ModeDef[] = [
  {
    id: "direct",
    label: "Direct",
    icon: "bubble",
    blurb: "One request. Context picked before the call. Right for most questions.",
    steps: () => 0
  },
  {
    id: "agent",
    label: "Agent",
    icon: "search",
    blurb: "Looks things up in your record as it goes, then answers.",
    steps: (n) => n
  },
  {
    id: "deep",
    label: "Deep",
    icon: "sparkle",
    blurb: "States a plan, works every step, then answers. For the questions worth waiting for.",
    steps: (n) => deepSteps(n)
  },
  /* A mode rather than a second Image switch, and the switch stays. The
     difference is what the thread is *for*: the action lets a reply come back
     as a picture, which is right when you are talking and a diagram would
     help. This turns the whole thread into a drawing surface — every message
     asks for a picture, and the two dials that decide its shape are on the
     composer instead of three menus deep. */
  {
    id: "image",
    label: "Image",
    icon: "image",
    blurb: "Every message draws. Shape and size sit beside the composer.",
    steps: () => 0
  }
];

const ACTION_ICON: Record<ChatActionId, IconName> = { web: "globe", think: "brain", image: "image" };

export default function ToolsMenu() {
  const {
    conversation,
    update,
    draftMode,
    setDraftMode,
    draftEffort,
    setDraftEffort,
    draftModel,
    draftActions,
    setDraftActions
  } = useChat();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);

  /* Whether a model can think is looked up in the model catalogue, which is
     fetched once and memoised. If it has not landed yet every row would read
     "unverified" for ever, because nothing else here would think to re-render
     when it arrives. */
  const [, bump] = useState(0);
  useEffect(() => {
    let live = true;
    void loadPricing().then(() => live && bump((n) => n + 1));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      /* Escape closes this popover and nothing else. Without stopPropagation
         the same keypress reaches ChatView's handler and closes the settings
         drawer behind it. */
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

  /* Everything below reads the conversation when there is one and the draft
     when there is not. The drafts are not a nicety: ChatContext's update()
     returns early with no conversation, so a control without one is a switch
     that lights up and does nothing until a thread exists to hold it. */
  const rawMode = conversation ? conversation.mode : draftMode;
  /* Every mode but the default is named here. A mode missing from this list
     is silently shown as Direct while the send path runs it for real, which
     is the worst of both — the picker would disagree with what the app is
     actually doing. */
  const mode: ChatMode = rawMode === "agent" || rawMode === "deep" || rawMode === "image" ? rawMode : "direct";
  const actions = conversation ? conversation.actions : draftActions;
  const pinnedEffort = conversation ? conversation.effort : draftEffort;

  /* Resolved through the project exactly as the send path resolves it, so the
     numbers on these rows are the numbers the loop will actually get. */
  const project = conversation ? store.get().projects[conversation.projectId] : store.activeProject();
  const effort: Effort = conversation ? resolveEffort(conversation, project).value : draftEffort || store.settings().effort;
  const agentSteps = budgetFor(effort).agentSteps;

  const resolved = AI.resolve({ backend: conversation?.backend, model: conversation?.model || draftModel });

  function setMode(m: ChatMode) {
    if (conversation) update({ mode: m });
    else setDraftMode(m);
  }
  function setEffort(e: Effort | "") {
    if (conversation) update({ effort: e });
    else setDraftEffort(e);
  }
  function toggleAction(id: ChatActionId) {
    const next = actions.includes(id) ? actions.filter((a) => a !== id) : [...actions, id];
    if (conversation) update({ actions: next });
    else setDraftActions(next);
  }

  const scope = conversation ? "this conversation" : "the next conversation";
  const current = MODES.find((m) => m.id === mode) || MODES[0];

  /* What the button says is what is in force behind it. At rest that is
     nothing worth reporting, so it says what it is; once the mode or the
     effort is not the default, it says that instead and lights up. */
  const modeSet = mode !== "direct";
  const label = modeSet
    ? current.label + (pinnedEffort ? " · " + pinnedEffort : "")
    : pinnedEffort
      ? pinnedEffort[0].toUpperCase() + pinnedEffort.slice(1) + " effort"
      : "Tools";

  /* An action switched on but not currently available — you turned Think on,
     then moved the model chip to something that cannot — stays in `actions`
     rather than being stripped, so it comes back when you move the model back.
     It just shows as off, and the send path will not send it. Image mode
     draws every message by itself (actionsFor), so its switch would be a
     control that can only ever read "on"; it is left off the bar there. */
  const switches = ACTION_ORDER.filter((id) => !(id === "image" && mode === "image"));

  return (
    <>
      <div className="toolsmenu" ref={wrap}>
        <button
          type="button"
          className={"ctool tools-btn" + (open ? " open" : "") + (modeSet || pinnedEffort ? " set" : "")}
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          title={modeSet ? current.blurb : "How this message is answered, and how much effort it gets"}
        >
          <Icon name={modeSet ? current.icon : "sliders"} size={17} />
          <span className="ctool-label">{label}</span>
        </button>

        {open && (
          <div className="tools-pop" role="menu">
            <div className="tools-sect">
              <div className="tools-head">How to answer {scope}</div>
              {MODES.map((m) => {
                const n = m.steps(agentSteps);
                return (
                  <button
                    key={m.id}
                    className={"tools-row" + (m.id === mode ? " on" : "")}
                    role="menuitemradio"
                    aria-checked={m.id === mode}
                    onClick={() => {
                      setMode(m.id);
                      setOpen(false);
                    }}
                  >
                    <Icon name={m.icon} size={14} className="tools-icon" />
                    <span className="tools-text">
                      <span className="tools-name">
                        {m.label}
                        <span className="tools-cost">{n ? "up to " + n + " lookups" : "1 request"}</span>
                      </span>
                      <span className="tools-blurb">{m.blurb}</span>
                    </span>
                    {m.id === mode && <Icon name="check" size={13} className="tools-tick" />}
                  </button>
                );
              })}
            </div>

            <div className="tools-sect">
              <div className="tools-head">
                <span>Effort</span>
                {pinnedEffort && (
                  <button className="tools-clear" onClick={() => setEffort("")}>
                    use the default
                  </button>
                )}
              </div>
              <div className="tools-seg" role="radiogroup" aria-label="Effort">
                {EFFORT_ORDER.map((e) => (
                  <button
                    key={e}
                    className={"tools-segbtn" + (e === effort ? " on" : "")}
                    role="radio"
                    aria-checked={e === effort}
                    onClick={() => setEffort(e)}
                  >
                    {e}
                  </button>
                ))}
              </div>
              {/* What effort buys in the mode currently selected. These were
                  two separate chips that both read as cost dials, and the app
                  contradicted itself across them: one promised lookups the
                  other had turned off. In one menu they can simply say it. */}
              <p className="tools-note">{effortMeans(effort, mode)}</p>
            </div>
          </div>
        )}
      </div>

      {switches.map((id) => {
        const action = CHAT_ACTIONS[id];
        const av = availability(id, resolved.backend.supports, resolved.model);
        const on = actions.includes(id) && av.can;
        /* A guess is labelled as a guess. The catalogue can answer for a
           hosted model and cannot for a local one, and pretending otherwise
           is how a hedge turns into a promise. */
        const title = av.can
          ? `${action.label}${on ? " is on" : ""} — ${action.blurb}${av.certain ? "" : " (unverified for this model)"}`
          : `${action.label} — ${av.why}`;
        return (
          <button
            key={id}
            type="button"
            className={"ctool ctool-icon" + (on ? " on" : "") + (av.can ? "" : " unable")}
            role="switch"
            aria-checked={on}
            /* aria-disabled rather than disabled: a disabled button swallows
               the hover that shows why, and the press that toasts it. */
            aria-disabled={!av.can}
            aria-label={action.label}
            title={title}
            onClick={() => (av.can ? toggleAction(id) : toast(av.why, 5000))}
          >
            <Icon name={ACTION_ICON[id]} size={18} />
          </button>
        );
      })}
    </>
  );
}
