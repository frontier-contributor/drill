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
 *
 * It opens the model browser (ui/ModelBrowser.tsx) in a dialog, for the kind
 * of model the surface needs — chat, image or video.
 * ========================================================================== */
import { useEffect, useState } from "react";
import * as AI from "@/services/ai";
import * as chatStore from "@/services/chatStore";
import { useToast } from "@/context/ToastContext";
import type { BackendType } from "@/types";
import type { Conversation, ModelKind } from "@/types/chat";
import Icon from "../ui/Icon";
import ModelDialog from "../ui/ModelDialog";
import { useModelList } from "../ui/useModelList";
import { catalogueEntry } from "@/services/pricing";

/** "anthropic/claude-sonnet-4" reads as its catalogue title in a chip, and as
 *  the tail of its id when the catalogue has not heard of it. */
function shortName(id: string): string {
  const title = catalogueEntry(id)?.title;
  const tail = title || id.split("/").pop() || id;
  return tail.length > 28 ? tail.slice(0, 27) + "…" : tail;
}

export default function ModelChip({
  conversation,
  draftModel,
  onDraftModel,
  kind = "chat",
  restrict,
  restrictNote,
  heading
}: {
  /** Null on the empty screen, where no conversation exists yet. */
  conversation: Conversation | null;
  draftModel: string;
  onDraftModel: (m: string) => void;
  /** Which kind of model this surface needs. Image mode asks for image
   *  models, Video mode for video models — so a thread whose every message is
   *  a picture cannot be pointed at a model that only writes. */
  kind?: ModelKind;
  restrict?: (id: string) => boolean;
  restrictNote?: string;
  /** Overrides the dialog's title. */
  heading?: string;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);

  const chosen = conversation ? conversation.model : draftModel;
  const backend = conversation ? conversation.backend : "";
  const resolved = AI.resolve({ backend, model: chosen });
  const pinned = !!chosen;
  const { models, loading, error } = useModelList(backend, open);

  useEffect(() => {
    if (error) toast(error, 5000);
  }, [error]); // eslint-disable-line react-hooks/exhaustive-deps

  function choose(model: string) {
    if (conversation) {
      conversation.model = model;
      chatStore.persist(conversation, true);
    } else {
      onDraftModel(model);
    }
    setOpen(false);
  }

  const title = heading || (conversation ? "Model for this conversation" : "Model for the next conversation");

  return (
    <div className="modelchip">
      <button
        className="cbtn ghost modelchip-btn"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
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
        <ModelDialog
          title={title}
          extra={
            pinned ? (
              <button type="button" className="mdlg-extra" onClick={() => choose("")} title="Follow the model set in Settings again">
                Use the default
              </button>
            ) : (
              <span className="mdlg-note">following the default</span>
            )
          }
          kind={kind}
          models={models}
          loading={loading}
          backend={(backend || resolved.type) as BackendType}
          value={resolved.model}
          onChoose={choose}
          restrict={restrict}
          restrictNote={restrictNote}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
