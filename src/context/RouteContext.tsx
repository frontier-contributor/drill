/* ============================================================================
 * RouteContext — a hash router in under 100 lines.
 *
 * Every route is scoped to a project, the same way the URL of a real
 * multi-tenant app is scoped to a workspace: it makes a link to "this
 * project's chat list" shareable and bookmarkable, and it is the seam that
 * keeps store.activeProjectId (what the review loop and every pane read
 * synchronously) and the address bar saying the same thing.
 *
 *   #/p/<id>/home               the dashboard: activity, streak, progress
 *   #/p/<id>/drill              the review loop, project <id> active
 *   #/p/<id>/cards              every card in the project, browsable
 *   #/p/<id>/chat               chat, no conversation selected
 *   #/p/<id>/chat/<cid>         a conversation
 *   #/p/<id>/journal            today's journal entry
 *   #/p/<id>/journal/<day>      a specific day, "2026-3-14"
 *   #/p/<id>/exam               the exam list / scope builder
 *   #/p/<id>/exam/<eid>         a specific exam, taking it or its report
 *   #/p/<id>/figures            figures and whiteboards you kept
 *   #/p/<id>/figures/<fid>      one of them, on its own page
 *
 * A hash with no section at all lands on home — that is what "home" means.
 *
 * Old two-segment links (#/drill, #/chat/<id>, from before projects existed)
 * still resolve — parse() reads them with projectId left blank, and the
 * mount-time redirect below fills in the active project and rewrites the
 * hash, so a stale bookmark heals itself on first visit.
 * ========================================================================== */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import * as store from "@/services/store";
import { isPersonalProject } from "@/lib/migrate";

export type View = "home" | "drill" | "cards" | "chat" | "journal" | "exam" | "figures";

export interface Route {
  view: View;
  projectId: string;
  conversationId: string | null;
  journalDay: string | null;
  examId: string | null;
  /** A kept figure, or a whiteboard — the section holds both, and both open
   *  from a link, which is the point of keeping one. */
  figureId: string | null;
}

function parse(hash: string): Omit<Route, "projectId"> & { projectId: string } {
  const clean = hash.replace(/^#\/?/, "");
  const parts = clean.split("/").filter(Boolean);
  let projectId = "";
  let rest = parts;
  if (parts[0] === "p" && parts[1]) {
    projectId = parts[1];
    rest = parts.slice(2);
  }
  const blank = { conversationId: null, journalDay: null, examId: null, figureId: null };
  if (rest[0] === "chat") return { view: "chat", projectId, ...blank, conversationId: rest[1] || null };
  if (rest[0] === "journal") return { view: "journal", projectId, ...blank, journalDay: rest[1] || null };
  if (rest[0] === "exam") return { view: "exam", projectId, ...blank, examId: rest[1] || null };
  if (rest[0] === "figures") return { view: "figures", projectId, ...blank, figureId: rest[1] || null };
  if (rest[0] === "drill") return { view: "drill", projectId, ...blank };
  if (rest[0] === "cards") return { view: "cards", projectId, ...blank };
  return { view: "home", projectId, ...blank };
}

function serialise(r: Route): string {
  const base = "#/p/" + r.projectId;
  if (r.view === "chat") return base + "/chat" + (r.conversationId ? "/" + r.conversationId : "");
  if (r.view === "journal") return base + "/journal" + (r.journalDay ? "/" + r.journalDay : "");
  if (r.view === "exam") return base + "/exam" + (r.examId ? "/" + r.examId : "");
  if (r.view === "figures") return base + "/figures" + (r.figureId ? "/" + r.figureId : "");
  if (r.view === "drill") return base + "/drill";
  if (r.view === "cards") return base + "/cards";
  return base + "/home";
}

/** A project id from the URL might be stale (deleted, archived, a typo in a
 *  hand-edited link) or simply absent (a legacy hash). Either way it resolves
 *  to something real, and — since store.activeProjectId is the single source
 *  of truth every non-route reader (DecksPane, ChatSidebar, …) uses directly
 *  — it is synced there too, so the two never disagree. */
function resolveProjectId(id: string): string {
  const projects = store.projects();
  const pid = id && projects[id] ? id : store.get().activeProjectId;
  if (pid !== store.get().activeProjectId) store.setActiveProject(pid);
  return pid;
}

function resolveRoute(hash: string): Route {
  const parsed = parse(hash);
  return { ...parsed, projectId: resolveProjectId(parsed.projectId) };
}

interface RouteCtx extends Route {
  go: (r: Partial<Route>) => void;
  openChat: (id?: string | null, projectId?: string) => void;
  openDrill: () => void;
  openHome: () => void;
  openCards: () => void;
  openJournal: (day?: string | null) => void;
  openExam: (id?: string | null) => void;
  openFigures: (id?: string | null) => void;
  /** Makes a project active and lands on its drill view (or chat, if you're
   *  already there) with no conversation selected — switching projects mid
   *  conversation would otherwise leave you pointed at a thread that just
   *  disappeared from the sidebar. */
  switchProject: (projectId: string) => void;
}

const Ctx = createContext<RouteCtx | null>(null);

export function RouteProvider({ children }: { children: ReactNode }) {
  const [route, setRoute] = useState<Route>(() => resolveRoute(window.location.hash));

  useEffect(() => {
    // Heals a missing, legacy or stale-project hash into its canonical form —
    // used both on mount and whenever the hash changes underneath us (back /
    // forward, a bookmarked legacy link), so the address bar never lags
    // behind what actually rendered.
    const apply = (hash: string) => {
      const resolved = resolveRoute(hash);
      const target = serialise(resolved);
      if (window.location.hash !== target) window.location.replace(target);
      setRoute(resolved);
    };
    const onHash = () => apply(window.location.hash);
    window.addEventListener("hashchange", onHash);
    apply(window.location.hash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = useCallback((next: Partial<Route>) => {
    setRoute((prev) => {
      const merged = { ...prev, ...next };
      const target = serialise(merged);
      if (window.location.hash !== target) window.location.hash = target;
      return merged;
    });
  }, []);

  const openChat = useCallback(
    (id?: string | null, projectId?: string) => {
      const patch: Partial<Route> = { view: "chat", conversationId: id ?? null };
      if (projectId) {
        store.setActiveProject(projectId);
        patch.projectId = projectId;
      }
      go(patch);
    },
    [go]
  );
  const openDrill = useCallback(() => go({ view: "drill", conversationId: null }), [go]);
  const openHome = useCallback(() => go({ view: "home", conversationId: null }), [go]);
  const openCards = useCallback(() => go({ view: "cards", conversationId: null }), [go]);
  const openJournal = useCallback((day?: string | null) => go({ view: "journal", journalDay: day ?? null }), [go]);
  const openExam = useCallback((id?: string | null) => go({ view: "exam", examId: id ?? null }), [go]);
  const openFigures = useCallback((id?: string | null) => go({ view: "figures", figureId: id ?? null }), [go]);
  const switchProject = useCallback(
    (projectId: string) => {
      store.setActiveProject(projectId);
      /* The personal space has no decks worth reviewing, no goals and no
         journal — it exists so a question can be asked without filing it
         anywhere. Landing on home there would show an empty dashboard and
         make it look broken, so it lands where the only thing in it lives. */
      const view = isPersonalProject(projectId) ? "chat" : route.view;
      go({ view, projectId, conversationId: null, journalDay: null, examId: null, figureId: null });
    },
    [go, route.view]
  );

  return (
    <Ctx.Provider value={{ ...route, go, openChat, openDrill, openHome, openCards, openJournal, openExam, openFigures, switchProject }}>
      {children}
    </Ctx.Provider>
  );
}

export function useRoute(): RouteCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useRoute must be used within RouteProvider");
  return ctx;
}
