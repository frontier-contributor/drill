/* ============================================================================
 * ModelPicker — the settings-side model control: a row whose button opens the
 * same model browser the chat composer's chip does.
 *
 * This used to be a plain text input backed by a native <datalist> that only
 * filled in after an explicit "Load model list" click, and then a popover
 * that Settings' scrolling column clipped. It is a button that says what is
 * chosen — by name, with its vendor — and opens the browser in a dialog.
 * ========================================================================== */
import { useEffect, useState } from "react";
import { useToast } from "@/context/ToastContext";
import { catalogueEntry } from "@/services/pricing";
import * as pricing from "@/services/pricing";
import { useStoreSync } from "@/hooks/useStoreSync";
import SettingRow from "./SettingRow";
import ModelDialog from "./ModelDialog";
import { useModelList } from "./useModelList";
import Icon from "./Icon";
import type { BackendType } from "@/types";
import type { ModelKind } from "@/types/chat";

/** A placeholder that names a model — a bare default id, or "Inherit (id)" —
 *  says the model's name instead of its id, like everything else that shows
 *  one now. Anything else is left as written. */
function humanize(text: string): string {
  const own = catalogueEntry(text)?.title;
  if (own) return `${own} · default`;
  return text.replace(/\(([^)]+)\)/, (whole, id: string) => {
    const t = catalogueEntry(id.trim())?.title;
    return t ? `(${t})` : whole;
  });
}

export default function ModelPicker({
  title = "Model",
  sub,
  origin,
  value,
  placeholder,
  backend,
  kind = "chat",
  models: fixed,
  allowTyped,
  onChange
}: {
  title?: string;
  sub?: string;
  origin?: string;
  value: string;
  placeholder?: string;
  backend?: BackendType | "";
  kind?: ModelKind;
  /** A list to choose from instead of asking the backend — voice mode's
   *  transcription models on a backend the catalogue does not describe. */
  models?: string[];
  allowTyped?: boolean;
  onChange: (v: string) => void;
}) {
  const toast = useToast();
  useStoreSync(pricing);
  const [open, setOpen] = useState(false);
  /* A backend is only asked for its list when the picker is about chat
     models; the other kinds come from the catalogue (or from `fixed`). */
  const asks = open && !fixed && kind === "chat";
  const { models, loading, error } = useModelList(backend || "", asks);

  useEffect(() => {
    if (error) toast(error, 5000);
  }, [error]); // eslint-disable-line react-hooks/exhaustive-deps

  function choose(id: string) {
    onChange(id);
    setOpen(false);
  }

  const e = value ? catalogueEntry(value) : undefined;

  return (
    <SettingRow title={title} sub={sub} origin={origin}>
      <button type="button" className="fi mdlpick-btn" onClick={() => setOpen(true)} aria-haspopup="dialog">
        <span className={"mdlpick-val" + (value ? "" : " placeholder")}>
          {value ? e?.title || value : placeholder ? humanize(placeholder) : "choose a model…"}
        </span>
        {value && e?.vendor && <span className="mdlpick-vendor">{e.vendor}</span>}
        <Icon name="chevron" size={11} className="mdlpick-chev" />
      </button>
      {open && (
        <ModelDialog
          title={title}
          kind={kind}
          models={fixed || models}
          trustList={!!fixed}
          loading={loading}
          backend={backend || ""}
          value={value}
          allowTyped={allowTyped}
          onChoose={choose}
          onClose={() => setOpen(false)}
        />
      )}
    </SettingRow>
  );
}
