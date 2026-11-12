/* ============================================================================
 * globalActions — what the command palette can do from anywhere.
 *
 * ctrl/cmd+K was chat's alone, so the fastest way to move around the app
 * existed in one section of seven. These are the actions that mean the same
 * thing wherever you are standing: go to a section, switch project, open a
 * settings page, flip the printing. Chat adds its own on top (ChatView) —
 * one list, because when you press the shortcut you know what you want, not
 * which category it lives in.
 *
 * Settings pages come from settings/catalogue.ts, the same declaration the
 * settings rail is drawn from, so a page added there is reachable here with
 * no second list to forget.
 * ========================================================================== */
import { useMemo } from "react";
import * as store from "@/services/store";
import * as projects from "@/services/projects";
import { useDrillStore } from "@/hooks/useDrillStore";
import { useRoute } from "@/context/RouteContext";
import { useSettings } from "@/context/SettingsContext";
import { applyAppearance } from "@/lib/theme";
import { CATEGORY_META } from "@/components/settings/catalogue";
import type { PaletteAction } from "@/components/chat/CommandPalette";

export function useGlobalActions(): PaletteAction[] {
  const db = useDrillStore();
  const route = useRoute();
  const settings = useSettings();
  const { projectId, view, openHome, openDrill, openCards, openJournal, openExam, openChat, openFigures, switchProject } =
    route;
  const night = db.settings.theme !== "day";
  /* Recomputed when a project is added, renamed or archived. */
  const projectKey = Object.values(db.projects)
    .map((p) => p.id + ":" + p.name + ":" + (p.archived ? 1 : 0))
    .join("|");

  return useMemo(() => {
    const sections: PaletteAction[] = (
      [
        ["home", "Home", openHome],
        ["drill", "Review", openDrill],
        ["cards", "Cards", openCards],
        ["journal", "Journal", () => openJournal()],
        ["exam", "Exam", () => openExam(null)],
        ["chat", "Chat", () => openChat(null)],
        ["figures", "Figures", () => openFigures(null)]
      ] as const
    )
      /* The section you are in is not a place to go. */
      .filter(([id]) => id !== view)
      .map(([id, label, run]) => ({ id: "go:" + id, label: "Go to " + label, hint: "section", run }));

    const others: PaletteAction[] = [...projects.list(), projects.personal()]
      .filter((p) => p.id !== projectId)
      .map((p) => ({
        id: "project:" + p.id,
        label: "Switch to " + p.name,
        hint: "project",
        run: () => switchProject(p.id)
      }));

    const pages: PaletteAction[] = CATEGORY_META.filter((c) => !c.needs).map((c) => ({
      id: "settings:" + c.id,
      label: "Settings — " + c.label,
      hint: "settings",
      run: () => settings.open(c.id)
    }));

    return [
      ...sections,
      { id: "new-chat", label: "New chat", hint: "action", run: () => openChat(null) },
      {
        id: "theme",
        label: night ? "Switch to the day printing" : "Switch to the night printing",
        hint: "action",
        run: () => {
          store.updateSettings({ theme: night ? "day" : "night" });
          applyAppearance(store.settings());
        }
      },
      ...others,
      ...pages
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, projectId, projectKey, night, settings]);
}
