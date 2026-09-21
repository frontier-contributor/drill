/* ============================================================================
 * ModelChip — which model this thread is talking to, in the composer bar.
 *
 * The model was only ever settable in two places, both of them panels you had
 * to go and find: global Settings, and the conversation settings drawer. But
 * choosing a model is a mid-conversation decision — you ask something cheap,
 * then something hard, and you want the bigger model for the hard one without
 * leaving the sentence you are writing.
 *
 * The three-level inheritance is the point, so the chip shows which level is
 * actually in force: a thread with no model of its own says "default" and
 * follows global Settings, and picking one here pins it to this thread only.
 * ========================================================================== */
import { useEffect, useRef, useState } from "react";
import * as AI from "@/services/ai";
import * as chatStore from "@/services/chatStore";
import { useToast } from "@/context/ToastContext";
import type { BackendType } from "@/types";
import type { Conversation } from "@/types/chat";
import Icon from "../ui/Icon";
import ModelPickerPanel from "../ui/ModelPickerPanel";

/** "anthropic/claude-sonnet-4" reads as "claude-sonnet-4" in a chip: the
 *  vendor prefix is the same on every row and eats the width. */
function shortName(id: string): string {
  const tail = id.split("/").pop() || id;
  return tail.length > 28 ? tail.slice(0, 27) + "…" : tail;
}

export default function ModelChip({
  conversation,
  draftModel,
  onDraftModel,
  restrict,
  restrictNote,
  heading
}: {
  /** Null on the empty screen, where no conversation exists yet. */
  conversation: Conversation | null;
  draftModel: string;
  onDraftModel: (m: string) => void;
  /** Narrow the list to one kind of model — the image composer passes
   *  `canDraw`, so a thread whose every message is a picture cannot be
   *  pointed at a model that only writes. */
  restrict?: (id: string) => boolean;
  restrictNote?: string;
  /** Overrides the popover's heading, so a restricted picker can say what it
   *  is restricted to instead of the generic line. */
  heading?: string;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const chosen = conversation ? conversation.model : draftModel;
  const backend = conversation ? conversation.backend : "";
  const resolved = AI.resolve({ backend, model: chosen });
  const pinned = !!chosen;

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  /* The list is fetched the first time the popover opens rather than on
     mount: most messages are sent without ever touching this, and a model
     list is a network call against the user's own key. */
  useEffect(() => {
    if (!open || models.length || loading) return;
    setLoading(true);
    AI.listModels(backend ? { backend } : undefined)
      .then(setModels)
      .catch((e: Error) => toast(e.message, 5000))
      .finally(() => setLoading(false));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  function choose(model: string) {
    if (conversation) {
      conversation.model = model;
      chatStore.persist(conversation, true);
    } else {
      onDraftModel(model);
    }
    setOpen(false);
  }

  return (
    <div className="modelchip" ref={boxRef}>
      <button
        className="cbtn ghost modelchip-btn"
        onClick={() => setOpen((v) => !v)}
        title={
          pinned
            ? `${conversation ? "This conversation is" : "The next conversation will be"} pinned to ${resolved.model}`
            : `Following the default from Settings: ${resolved.model}`
        }
      >
        <span className={"modelchip-dot" + (pinned ? " pinned" : "")} />
        <span className="modelchip-name">{shortName(resolved.model || "no model")}</span>
        <Icon name="chevron" size={11} />
      </button>

      {open && (
        <div className="modelpop">
          <div className="modelpop-head">
            <span>{heading || (conversation ? "Model for this conversation" : "Model for the next conversation")}</span>
            {pinned && (
              <button className="modelpop-clear" onClick={() => choose("")}>
                use the default
              </button>
            )}
          </div>

          <ModelPickerPanel
            models={models}
            loading={loading}
            backend={(backend || resolved.type) as BackendType}
            value={resolved.model}
            onChoose={choose}
            restrict={restrict}
            restrictNote={restrictNote}
            autoFocus
          />
        </div>
      )}
    </div>
  );
}
