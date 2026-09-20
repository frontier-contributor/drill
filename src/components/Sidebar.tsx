/* ============================================================================
 * Sidebar — the running head, stood on its end.
 *
 * One navigation for the whole app: the project, the seven sections, whatever
 * the current section wants to hang underneath them (chat puts its
 * conversation index there), and the two global tools at the foot.
 *
 * Three states, and the CSS in style.css is written so all three are the same
 * element rather than three components:
 *   · open      — 17rem, labels showing
 *   · collapsed — a 56px rail of icons, remembered in Settings.navCollapsed
 *   · drawer    — under 900px it leaves the flow entirely and slides in over
 *                 the page with a scrim, because a rail plus a page does not
 *                 fit on a phone
 * ========================================================================== */
import type { ReactNode } from "react";
import * as store from "@/services/store";
import * as journalStore from "@/services/journalStore";
import { useDrillStore } from "@/hooks/useDrillStore";
import { useStoreSync } from "@/hooks/useStoreSync";
import { useRoute, type View } from "@/context/RouteContext";
import { applyAppearance } from "@/lib/theme";
import { useSettings } from "@/context/SettingsContext";
import ProjectSwitcher from "./ProjectSwitcher";
import Icon, { type IconName } from "./ui/Icon";

const SECTIONS: { view: View; label: string; icon: IconName }[] = [
  { view: "home", label: "Home", icon: "home" },
  { view: "drill", label: "Review", icon: "review" },
  { view: "cards", label: "Cards", icon: "cards" },
  { view: "journal", label: "Journal", icon: "journal" },
  { view: "exam", label: "Exam", icon: "exam" },
  { view: "chat", label: "Chat", icon: "bubble" },
  /* Last, because that is where its contents come from: you keep a figure out
     of a conversation, and this is where it lands. */
  { view: "figures", label: "Figures", icon: "figure" }
];

export default function Sidebar({
  current,
  collapsed,
  open,
  onToggle,
  onNavigate,
  onShortcuts,
  children
}: {
  current: View;
  collapsed: boolean;
  open: boolean;
  onToggle: () => void;
  onNavigate: () => void;
  /** Shell owns the cheatsheet, so opening it from here and opening it with
   *  "?" cannot put two of them on the screen at once. */
  onShortcuts: () => void;
  children?: ReactNode;
}) {
  const db = useDrillStore();
  useStoreSync(journalStore);
  const { openHome, openDrill, openCards, openChat, openJournal, openExam, openFigures } = useRoute();
  /* Shell renders the panel, so this only asks for it. The sidebar used to
     hold its own copy, which is how chat ended up with a second settings
     surface that the sidebar's one knew nothing about. */
  const settings = useSettings();

  const dueCount = store.counts().due;
  const unrolledCount = journalStore.unrolledEntries(db.activeProjectId).length;

  const badges: Partial<Record<View, number>> = {
    drill: dueCount > 0 ? dueCount : undefined,
    journal: unrolledCount > 0 ? unrolledCount : undefined
  };

  const go: Record<View, () => void> = {
    home: openHome,
    drill: openDrill,
    cards: openCards,
    chat: () => openChat(null),
    journal: () => openJournal(),
    exam: () => openExam(null),
    figures: () => openFigures(null)
  };

  /* The printing lives one click away rather than only in Settings: which one
     you want depends on the light in the room, which changes far more often
     than anything else in there. */
  const night = db.settings.theme !== "day";
  function flipTheme() {
    store.updateSettings({ theme: night ? "day" : "night" });
    applyAppearance(store.settings());
  }

  return (
    <aside
      className={"nav" + (collapsed ? " collapsed" : "") + (open ? " open" : "")}
      aria-label="Sections"
      /* Collapsed, the rail is still fully operable — it is the icons that
         go away, not the navigation — but its labels are hidden from the
         accessibility tree along with the eye, so each control falls back to
         its title/aria-label rather than reading out as empty. */
      data-collapsed={collapsed ? "true" : undefined}
    >
      <div className="nav-head">
        <span className="nav-brand">Drill</span>
        <button
          className="iconbtn nav-toggle"
          onClick={onToggle}
          title={collapsed ? "Expand sidebar  (ctrl + b)" : "Collapse sidebar  (ctrl + b)"}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
        >
          <Icon name="panel" />
        </button>
      </div>

      <div className="nav-project">
        <ProjectSwitcher variant="inline" />
      </div>

      <nav className="nav-sections">
        {SECTIONS.map((s) => {
          const badge = badges[s.view];
          return (
            <button
              key={s.view}
              className={"nav-item" + (s.view === current ? " on" : "")}
              aria-current={s.view === current ? "page" : undefined}
              title={s.label + (badge ? ` (${badge})` : "")}
              onClick={() => {
                go[s.view]();
                onNavigate();
              }}
            >
              <Icon name={s.icon} size={17} />
              <span className="nav-label">{s.label}</span>
              {badge != null && <span className="nav-badge">{badge}</span>}
            </button>
          );
        })}
      </nav>

      {/* Whatever the section wants under its own name. Hidden in the rail,
          where there is no room for a list of titles. */}
      {children && <div className="nav-extra">{children}</div>}

      <div className="nav-foot">
        <button
          className="nav-item"
          onClick={flipTheme}
          title={night ? "Day printing" : "Night printing"}
          aria-label={night ? "Switch to the day printing" : "Switch to the night printing"}
        >
          <Icon name={night ? "sun" : "moon"} size={17} />
          <span className="nav-label">{night ? "Day" : "Night"}</span>
        </button>
        <button
          className="nav-item"
          onClick={onShortcuts}
          title="Keyboard shortcuts (?)"
          aria-label="Keyboard shortcuts"
        >
          <Icon name="keyboard" size={17} />
          <span className="nav-label">Shortcuts</span>
        </button>
        <button
          className="nav-item"
          onClick={() => settings.open()}
          title="Settings  (ctrl + ,)"
          aria-label="Settings"
        >
          <Icon name="settings" size={17} />
          <span className="nav-label">Settings</span>
        </button>
      </div>
    </aside>
  );
}
