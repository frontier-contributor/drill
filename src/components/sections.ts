/* ============================================================================
 * sections — where each lazy section comes from, and how to fetch one early.
 *
 * Every section but Review is its own chunk, so the review loop does not pay
 * for chat's renderer or the journal's views. The price of that used to be
 * paid at the worst moment: the first click on a section fetched its chunk
 * while the whole app was replaced by the title page. Splitting is right;
 * waiting until the click to start is not.
 *
 * So the same import() that React.lazy uses is reachable from two more
 * places — the pointer arriving on a navigation item, and a quiet moment
 * after boot — and by the time a section is asked for it is usually already
 * here. A dynamic import is memoised by the module system, so asking early
 * and asking again from React.lazy is one request, not two.
 *
 * Review is absent on purpose: it is the entry chunk, already loaded.
 * ========================================================================== */
import type { ComponentType } from "react";
import type { View } from "@/context/RouteContext";

type Loader = () => Promise<{ default: ComponentType }>;

export const SECTION_LOADERS: Record<Exclude<View, "drill">, Loader> = {
  home: () => import("@/components/home/HomeView"),
  cards: () => import("@/components/cards/CardsView"),
  journal: () => import("@/components/journal/JournalView"),
  exam: () => import("@/components/exam/ExamView"),
  figures: () => import("@/components/figures/FiguresView"),
  /* Chat's provider rides with its view. ChatProvider imports the agent
     loop, drawing, video and the file wire; mounted eagerly from App it put
     all of that in the bundle the review loop starts from. */
  chat: () => import("@/components/chat/ChatRoot")
};

const asked = new Set<View>();

/** Start fetching a section's chunk. Safe to call any number of times, from
 *  a hover or a timer: the first call does the work and the rest are free. */
export function preloadSection(view: View): void {
  if (view === "drill" || asked.has(view)) return;
  asked.add(view);
  /* A preload that fails must not surface — nobody asked for anything yet.
     It is forgotten rather than remembered, so the real request (React.lazy,
     on the click) runs again and reports through the root guard, which is
     where "Drill has been updated — Reload" is said. */
  SECTION_LOADERS[view]().catch(() => asked.delete(view));
}

/* Lightest first, chat last: it is the largest by a distance (the markdown
   renderer, KaTeX, highlight.js), and by the time the queue reaches it the
   sections more likely to be opened next are already in. */
const IDLE_ORDER: View[] = ["home", "cards", "journal", "exam", "figures", "chat"];

/** Fetch every section in the background once the app has settled, one per
 *  idle period so no single task holds the main thread while a card is being
 *  graded. Skipped entirely under Data Saver, where bytes nobody asked for
 *  are exactly what the setting refuses. */
export function preloadSectionsWhenIdle(): () => void {
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (conn?.saveData) return () => undefined;

  let cancelled = false;
  let timer = 0;
  let i = 0;

  const later = (fn: () => void) => {
    /* Safari has no requestIdleCallback; a short timer is the honest
       substitute. The timeout matters in a background tab, where idle
       periods are rare and the queue would otherwise never drain. */
    if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(fn, { timeout: 4000 });
    else timer = window.setTimeout(fn, 250);
  };

  const next = () => {
    if (cancelled || i >= IDLE_ORDER.length) return;
    preloadSection(IDLE_ORDER[i++]);
    later(next);
  };

  /* Not at once: the first second belongs to whatever the app opened on. */
  timer = window.setTimeout(() => later(next), 1200);

  return () => {
    cancelled = true;
    window.clearTimeout(timer);
  };
}
