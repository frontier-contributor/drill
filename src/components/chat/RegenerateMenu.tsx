/* ============================================================================
 * RegenerateMenu — a split button on every reply: the left half redoes the
 * answer with whatever model is already in force, the right half opens the
 * model browser for trying a different one.
 *
 * The composer's ModelChip pins a choice to the whole thread going forward,
 * which is the wrong tool for "try that again with a bigger model" — you end
 * up pinning, regenerating, then remembering to unpin. This keeps that
 * comparison to a single click: the override applies to this one variant
 * only and never touches conversation.model.
 *
 * Its own picker was the last of the naive ones — forty raw ids and a search
 * box. It opens the same browser everything else does now, where "which one
 * is bigger" can actually be read off the card.
 * ========================================================================== */
import { useEffect, useState } from "react";
import { useToast } from "@/context/ToastContext";
import type { BackendType } from "@/types";
import Icon from "../ui/Icon";
import ModelDialog from "../ui/ModelDialog";
import { useModelList } from "../ui/useModelList";
import * as AI from "@/services/ai";

export default function RegenerateMenu({
  backend,
  currentModel,
  busy,
  onRegenerate
}: {
  backend: BackendType | "";
  /** Resolved model in force for this thread — the row it's already on gets marked. */
  currentModel: string;
  busy: boolean;
  onRegenerate: (override?: { backend?: BackendType | ""; model?: string }) => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const { models, loading, error } = useModelList(backend, open);

  useEffect(() => {
    if (error) toast(error, 5000);
  }, [error]); // eslint-disable-line react-hooks/exhaustive-deps

  function pick(model: string) {
    setOpen(false);
    onRegenerate({ backend, model });
  }

  return (
    <div className="regenmenu">
      <button
        className="tact regenmenu-main"
        onClick={() => onRegenerate()}
        disabled={busy}
        title="Regenerate with the current model"
      >
        <Icon name="sparkle" size={11} />
        <span>Regenerate</span>
      </button>
      <button
        className="tact regenmenu-caret"
        onClick={() => setOpen(true)}
        disabled={busy}
        title="Regenerate with a different model"
        aria-label="Regenerate with a different model"
        aria-haspopup="dialog"
      >
        <Icon name="chevron" size={10} />
      </button>

      {open && (
        <ModelDialog
          title="Regenerate with…"
          extra={<span className="mdlg-note">this reply only — the thread keeps its model</span>}
          kind="chat"
          models={models}
          loading={loading}
          backend={(backend || AI.resolve({ backend }).type) as BackendType}
          value={currentModel}
          onChoose={pick}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
