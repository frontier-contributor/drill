/* ============================================================================
 * Shell — the frame every section is rendered into.
 *
 *   .app                     fixed, a row: rail on the left, everything else
 *     <Sidebar/>             the one navigation
 *     .app-main              a column
 *       <SaveAlarm/>         only when a write has failed: the one alarm
 *       .topbar              only under 900px: the drawer handle
 *       .app-body            a row
 *         .app-col           a column
 *           {children}       the section, which owns its own scrolling
 *           .app-dock        optional: the grade bar
 *         <aside .app-rail>  optional: the instrument panel, foldable
 *
 * The sidebar, the dock and the rail are all siblings of the scroll
 * container, never inside it, which is what makes it impossible to scroll the
 * navigation off the screen — the bug this shell was built around. The rail
 * is subject to the same rule for the same reason: a panel that tells you how
 * far through today you are is worthless if the page can push it away.
 * ========================================================================== */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import * as store from "@/services/store";
import { useDrillStore } from "@/hooks/useDrillStore";
import type { View } from "@/context/RouteContext";
import { applyAppearance } from "@/lib/theme";
import Sidebar from "./Sidebar";
import ErrorGuard from "./ui/ErrorGuard";
import SaveAlarm from "./ui/SaveAlarm";
import ShortcutsModal from "./ui/ShortcutsModal";
import SettingsSurface from "./settings/SettingsSurface";
import Icon from "./ui/Icon";
import { useSettings } from "@/context/SettingsContext";

const MOBILE = "(max-width: 900px)";

const TITLES: Record<View, string> = {
  home: "Home",
  drill: "Review",
  cards: "Cards",
  journal: "Journal",
  exam: "Exam",
  chat: "Chat",
  figures: "Figures"
};

export default function Shell({
  current,
  sidebar,
  dock,
  aside,
  asideLabel = "Panel",
  children
}: {
  current: View;
  /** Extra sidebar content for this section, under the section list. */
  sidebar?: ReactNode;
  /** Docked below the scroll area — the grade bar. */
  dock?: ReactNode;
  /** The right-hand instrument panel. Foldable to a narrow edge — the state
   *  lives in Settings.railCollapsed, so it holds across sections and
   *  reloads. Hidden entirely below 1180px, where the reading column needs
   *  the width more than the readouts do. */
  aside?: ReactNode;
  /** What the folded rail's tab says. Shell cannot know what is in the panel,
   *  and a tab reading "Today" beside a card library is worse than no tab. */
  asideLabel?: string;
  children: ReactNode;
}) {
  const db = useDrillStore();
  const settings = useSettings();
  const [drawer, setDrawer] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const [mobile, setMobile] = useState(
    () => typeof window !== "undefined" && window.matchMedia(MOBILE).matches
  );

  useEffect(() => {
    const mq = window.matchMedia(MOBILE);
    const sync = () => {
      setMobile(mq.matches);
      // Widening the window with the drawer open would otherwise leave the
      // scrim over a sidebar that is now docked in the layout anyway.
      if (!mq.matches) setDrawer(false);
    };
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  /* Collapsing is a desktop idea. On a phone the same control opens the
     drawer, and Settings.navCollapsed is left alone so the two devices do
     not overwrite each other's preference. */
  const collapsed = !mobile && !!db.settings.navCollapsed;
  const railFolded = !!db.settings.railCollapsed;

  const toggleRail = useCallback(() => {
    store.updateSettings({ railCollapsed: !store.settings().railCollapsed });
  }, []);

  const toggle = useCallback(() => {
    if (window.matchMedia(MOBILE).matches) setDrawer((v) => !v);
    else store.updateSettings({ navCollapsed: !store.settings().navCollapsed });
  }, []);

  const night = db.settings.theme !== "day";
  const flipTheme = useCallback(() => {
    store.updateSettings({ theme: night ? "day" : "night" });
    applyAppearance(store.settings());
  }, [night]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") {
        if (e.key === "?" && !e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          setShortcuts((v) => !v);
          return;
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggle();
      } else if ((e.ctrlKey || e.metaKey) && e.key === "\\") {
        /* Not ctrl+J: chat already binds that to "new conversation", so both
           handlers fired and folding the panel also started a new thread.
           Backslash is unbound in Chrome and reads as a divider. */
        e.preventDefault();
        toggleRail();
      } else if ((e.ctrlKey || e.metaKey) && e.key === ",") {
        /* The conventional one, and it works from every section because
           there is one settings surface now. Bound here rather than in the
           sidebar so it fires with the navigation collapsed or on a phone,
           where the sidebar is a drawer that is usually shut. */
        e.preventDefault();
        settings.open();
      } else if (e.key === "Escape") {
        /* Innermost first. Settings sits over everything else, so it is the
           thing Escape means while it is open. */
        if (settings.cat) settings.close();
        else if (shortcuts) setShortcuts(false);
        else if (drawer) setDrawer(false);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [toggle, toggleRail, drawer, shortcuts, settings]);

  const activeProject = store.activeProject();

  return (
    <div className={"app" + (collapsed ? " nav-collapsed" : "")}>
      <Sidebar
        current={current}
        collapsed={collapsed}
        open={drawer}
        onToggle={toggle}
        onNavigate={() => setDrawer(false)}
        onShortcuts={() => setShortcuts(true)}
      >
        {sidebar}
      </Sidebar>

      {drawer && <div className="nav-scrim" onClick={() => setDrawer(false)} />}

      <div className="app-main">
        {/* Outside .app-scroll like the sidebar and the dock, and for a
            stronger version of the same reason: a warning that the app is
            failing to save your work must not be something you can scroll
            past. Renders nothing at all in the normal case.

            Guarded because there is still no error boundary above Shell, and
            the one component whose entire job is to appear when things have
            gone wrong is the last one that should be able to white-screen the
            app on its way in. */}
        <ErrorGuard>
          <SaveAlarm />
        </ErrorGuard>

        <div className="topbar">
          <button className="iconbtn" onClick={toggle} aria-label="Open navigation" aria-expanded={drawer}>
            <Icon name="panel" />
          </button>
          <div className="topbar-title-wrap">
            <span className="topbar-title">{TITLES[current]}</span>
            <span className="topbar-sub">· {activeProject.name}</span>
          </div>
          <div className="topbar-acts">
            <button
              className="iconbtn"
              onClick={flipTheme}
              title={night ? "Day printing" : "Night printing"}
              aria-label="Toggle theme"
            >
              <Icon name={night ? "sun" : "moon"} size={16} />
            </button>
            <button
              className="iconbtn"
              onClick={() => setShortcuts(true)}
              title="Keyboard shortcuts (?)"
              aria-label="Shortcuts"
            >
              <Icon name="keyboard" size={16} />
            </button>
          </div>
        </div>

        <div className="app-body">
          <div className="app-col">
            {children}

            {dock && (
              <div className="app-dock">
                <div className="dock-inner">{dock}</div>
              </div>
            )}
          </div>

          {/* Folded, the rail keeps its edge and its handle rather than
              vanishing: a panel that disappears without trace is a panel you
              forget you can bring back. */}
          {aside && (
            <aside className={"app-rail" + (railFolded ? " folded" : "")}>
              <button
                className="iconbtn rail-toggle"
                onClick={toggleRail}
                title={railFolded ? "Show the panel  (ctrl + \\)" : "Hide the panel  (ctrl + \\)"}
                aria-label={railFolded ? "Show the panel" : "Hide the panel"}
                aria-expanded={!railFolded}
              >
                <Icon name="chevron" size={14} className="rail-chev" />
                <span className="rail-tab">{asideLabel}</span>
              </button>
              {!railFolded && <div className="rail-body">{aside}</div>}
            </aside>
          )}
        </div>
      </div>

      {shortcuts && <ShortcutsModal onClose={() => setShortcuts(false)} />}

      {/* The one settings window in the app. Rendered from the shell every
          section mounts, so it is the same window with the same navigation
          whether you were reviewing, chatting or writing the journal. */}
      <SettingsSurface />
    </div>
  );
}
