/* ============================================================================
 * SettingsContext — settings is one thing, opened from everywhere.
 *
 * It used to be three surfaces that had drifted apart: a modal off the
 * sidebar, a drawer inside chat with its own header and close button, and a
 * review-loop sheet pane that nothing had opened since the sheet router
 * gained it. Whether a given setting was reachable depended on which of the
 * three you had found, and the things people actually go looking for — the
 * backup that moves a browser's worth of work somewhere else, everything the
 * assistant remembers about you, the transcript of what it just sent — were in
 * none of them. They were in the review loop's Menu, behind a sheet that is
 * only mounted while the review loop is on screen.
 *
 * So: one piece of state, held above every view, saying which page is open (or
 * none) and, optionally, which group on it to jump to. Anything can call
 * `open()`; exactly one surface renders it, from Shell, which is the one
 * component every section agrees on.
 *
 * The surface renders in Shell rather than here on purpose. Some pages need a
 * context only their own view provides — "This chat" reads ChatProvider — and
 * Shell is inside whatever providers its section mounted, where a provider up
 * here would be outside all of them.
 * ========================================================================== */
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import type { CatId, SectionId } from "@/components/settings/catalogue";

interface SettingsCtx {
  /** The page on screen, or null when settings is closed. There is no second
   *  copy of this inside the panel: the rail writes here too, so "which page
   *  is showing" has one answer and `open("data")` from anywhere works whether
   *  settings is closed or already open on another page. */
  cat: CatId | null;
  /** The group to scroll to and flash once that page has drawn, or null. A
   *  search result is a *setting*, not a page, so landing on the page and
   *  leaving you to find it again would waste the search. */
  at: SectionId | null;
  open: (cat?: CatId, at?: SectionId) => void;
  close: () => void;
  /** Called by the group that answered the jump. One-shot on purpose:
   *  re-rendering the page for an unrelated reason must not scroll it again
   *  under someone who has since scrolled somewhere else. */
  clearAt: () => void;
}

const Ctx = createContext<SettingsCtx | null>(null);

/** Where settings lands when opened with no page named. Connection is first
 *  for the same reason it is first in the rail: it is the one page that
 *  decides whether the app does anything at all. */
const DEFAULT_CAT: CatId = "connection";

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [cat, setCat] = useState<CatId | null>(null);
  const [at, setAt] = useState<SectionId | null>(null);
  /* Where you were when you last closed it. Settings is a place you leave to
     check something and come straight back to, and landing on Connection
     every time makes the second visit cost as much as the first. */
  const last = useRef<CatId>(DEFAULT_CAT);

  const open = useCallback((next?: CatId, section?: SectionId) => {
    const target = next || last.current;
    last.current = target;
    setCat(target);
    setAt(section ?? null);
  }, []);
  const close = useCallback(() => {
    setCat(null);
    setAt(null);
  }, []);
  const clearAt = useCallback(() => setAt(null), []);

  const value = useMemo(() => ({ cat, at, open, close, clearAt }), [cat, at, open, close, clearAt]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSettings(): SettingsCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSettings must be used within SettingsProvider");
  return ctx;
}
