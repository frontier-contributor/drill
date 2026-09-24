import { Suspense, lazy, useEffect, useRef, useState } from "react";
import * as CFG from "@/lib/config";
import * as store from "@/services/store";
import * as chatStore from "@/services/chatStore";
import * as memoryStore from "@/services/memoryStore";
import * as candidates from "@/services/candidates";
import * as journalStore from "@/services/journalStore";
import * as examStore from "@/services/examStore";
import * as usageLog from "@/services/usageLog";
import * as figures from "@/services/figures";
import * as storage from "@/services/storage";
import * as autoBackup from "@/services/autoBackup";
import { applyAppearance } from "@/lib/theme";
import { useDrillStore } from "@/hooks/useDrillStore";
import { ToastProvider } from "@/context/ToastContext";
import { SheetProvider } from "@/context/SheetContext";
import { SettingsProvider } from "@/context/SettingsContext";
import { ReviewProvider } from "@/context/ReviewContext";
import { RouteProvider, useRoute } from "@/context/RouteContext";
import { ChatProvider } from "@/context/ChatContext";
import AppShell from "@/components/AppShell";
import { BootRescue } from "@/components/Rescue";

/** Renders nothing — just keeps :root's appearance custom properties in sync
 *  with Settings, for both the drill and chat views. Split out so it can sit
 *  above the view branch in Views() without either view needing to know
 *  appearance exists. */
function AppearanceSync() {
  const db = useDrillStore();
  useEffect(() => {
    applyAppearance(db.settings);
  }, [db.settings.theme, db.settings.accent, db.settings.density, db.settings.textScale]);
  return null;
}

/* Home, chat, journal and exam all pull in weight the review loop should not pay
   for on its first paint (KaTeX/highlight.js for chat; the journal/exam
   views are smaller but still no reason to ship on the daily path) — each is
   its own chunk, lazy-loaded only when its view is actually opened. */
const HomeView = lazy(() => import("@/components/home/HomeView"));
const CardsView = lazy(() => import("@/components/cards/CardsView"));
const ChatView = lazy(() => import("@/components/chat/ChatView"));
const JournalView = lazy(() => import("@/components/journal/JournalView"));
const ExamView = lazy(() => import("@/components/exam/ExamView"));
const FiguresView = lazy(() => import("@/components/figures/FiguresView"));

/** Shown twice: while the store loads at cold start, and again for the half
 *  second a lazy view takes to arrive. Set as a title page rather than a
 *  spinner — it is the first thing the app ever shows, and a lone grey dot on
 *  black is a poor first sentence. */
function LoadingShell() {
  return (
    <div className="app">
      <div className="app-scroll">
        <div className="boot">
          <div className="boot-mark">Drill</div>
          <div className="working-stick" aria-hidden="true">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <i key={i} style={{ animationDelay: i * 0.12 + "s" }} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Views() {
  const { view } = useRoute();

  if (view === "home") {
    return (
      <Suspense fallback={<LoadingShell />}>
        <HomeView />
      </Suspense>
    );
  }

  if (view === "cards") {
    return (
      <Suspense fallback={<LoadingShell />}>
        <CardsView />
      </Suspense>
    );
  }

  if (view === "chat") {
    return (
      <ChatProvider>
        <Suspense fallback={<LoadingShell />}>
          <ChatView />
        </Suspense>
      </ChatProvider>
    );
  }

  if (view === "journal") {
    return (
      <Suspense fallback={<LoadingShell />}>
        <JournalView />
      </Suspense>
    );
  }

  if (view === "exam") {
    return (
      <Suspense fallback={<LoadingShell />}>
        <ExamView />
      </Suspense>
    );
  }

  if (view === "figures") {
    return (
      <Suspense fallback={<LoadingShell />}>
        <FiguresView />
      </Suspense>
    );
  }

  return (
    <SheetProvider>
      <ReviewProvider>
        <AppShell />
      </ReviewProvider>
    </SheetProvider>
  );
}

export default function App() {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<Error | null>(null);
  const booted = useRef(false);

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    CFG.load()
      .then((cfg) => {
        store.init(cfg);
        // Conversation metadata loads in the background: the review loop must
        // not wait on IndexedDB to render.
        void chatStore.init();
        void memoryStore.init();
        void candidates.init();
        void journalStore.init();
        void examStore.init();
        void usageLog.init();
        /* Kept figures load at boot rather than with their section, because
           the Keep button in every reply has to know whether this figure is
           already on the shelf before you press it. */
        void figures.init();
        // Ask the browser not to evict us. Chrome usually grants it silently,
        // Firefox prompts, Safari decides for itself — a refusal is normal and
        // only means the export in Import/export matters more.
        void storage.requestPersistence();
        /* Links back up to the folder chosen in an earlier session, if any;
           the first snapshot waits for the app to settle. */
        void autoBackup.init();
        setStatus("ready");
      })
      .catch((e: Error) => {
        setError(e);
        setStatus("error");
      });
  }, []);

  /* Both the usage ledger and the database itself write on a debounce, and
     both are written from every view rather than just chat — so the flush
     lives here rather than in ChatContext, which only mounts for one of them.
     The database was missing from this until now: store.save() waits 90ms so
     a burst of edits is one write, which meant grading a card and closing the
     tab inside that window lost the grade outright. */
  useEffect(() => {
    const flush = () => {
      store.flush();
      usageLog.flushAll();
    };
    const onHide = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flush);
    };
  }, []);

  if (status === "error" && error) {
    return <BootRescue error={error} unreadable={error instanceof store.UnreadableDatabaseError} />;
  }

  if (status === "loading") return <LoadingShell />;

  return (
    <ToastProvider>
      <AppearanceSync />
      {/* Which settings page is open is one piece of state for the whole app,
          held above the view branch so it survives moving between sections
          and so every section's Shell renders the same panel. */}
      <SettingsProvider>
        <RouteProvider>
          <Views />
        </RouteProvider>
      </SettingsProvider>
    </ToastProvider>
  );
}
