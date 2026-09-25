/* ============================================================================
 * ModelDialog — the model browser, over everything, wherever it was opened.
 *
 * The old picker was a popover anchored to whatever opened it. That was fine
 * at 460px and wrong at the size a two-pane browser needs: anchored to the
 * chat chip at the composer's right edge it ran off the left of the window,
 * and inside Settings it opened in a scrolling column that clipped it. A
 * dialog cannot be clipped by its opener. On a phone it is a sheet from the
 * bottom edge, which is where a thumb already is.
 *
 * Escape is taken in the capture phase and stopped, the way the project
 * switcher's dialogs take it: closing this must not also close the settings
 * panel it was opened from, or the drawer under it. Focus goes back to
 * whatever opened it.
 * ========================================================================== */
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Icon from "./Icon";
import ModelBrowser, { type ModelBrowserProps } from "./ModelBrowser";

export interface ModelDialogProps extends ModelBrowserProps {
  title: string;
  /** Beside the title: "Use the default", a note about the restriction. */
  extra?: ReactNode;
  onClose: () => void;
}

export default function ModelDialog({ title, extra, onClose, ...browser }: ModelDialogProps) {
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    opener.current = document.activeElement;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      onClose();
    }
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      const el = opener.current as HTMLElement | null;
      /* Only if focus is not already somewhere deliberate — the choice may
         have moved it on (the composer, a new row). */
      if (el && typeof el.focus === "function" && (document.activeElement === document.body || !document.activeElement)) el.focus();
    };
  }, [onClose]);

  return createPortal(
    <div
      className="mdlg-wrap"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="mdlg" role="dialog" aria-modal="true" aria-label={title}>
        <div className="mdlg-head">
          <strong>{title}</strong>
          {extra}
          <button type="button" className="iconbtn mdlg-close" onClick={onClose} aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </div>
        <ModelBrowser {...browser} autoFocus />
      </div>
    </div>,
    document.body
  );
}
