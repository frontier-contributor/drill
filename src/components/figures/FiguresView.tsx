/* ============================================================================
 * FiguresView — the shelf: every figure you kept, and every whiteboard you
 * drew, in the one place that is not a conversation.
 *
 * A figure used to exist only inside the reply that drew it. That is the right
 * home for it while you are talking — branching, export and backup carry it
 * with no code of their own (lib/visuals/artifacts.ts) — and the wrong one the
 * moment it turns out to be the picture that finally made something clear: a
 * thread is a conversation, not a shelf, and the only way back to it was to
 * remember which of four hundred messages it was in.
 *
 * Whiteboards were worse. They have been saved since the day they shipped and
 * listed by nothing at all — `listBoards` had a single caller, the backup — so
 * a board you drew survived the reload and could never be opened again. They
 * are on this page for the same reason the figures are, and it is the same
 * page because from where you are standing they are the same kind of thing.
 *
 * Two shapes, one route. `#/p/<id>/figures` is the list; `#/p/<id>/figures/<id>`
 * is one of them on its own page. One at a time is deliberate rather than
 * lazy: a wall of live charts and running canvases is a wall of work for the
 * browser, and the figure you came back for wants the width anyway.
 *
 * It mounts SheetProvider and ReviewProvider for exactly the reason CardsView
 * does — "Make cards" is the review loop's own pane, and a figure that can
 * become cards is the whole argument for keeping one.
 * ========================================================================== */
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import * as store from "@/services/store";
import * as figures from "@/services/figures";
import * as chatStore from "@/services/chatStore";
import * as boards from "@/services/boards";
import { useDrillStore } from "@/hooks/useDrillStore";
import { useStoreSync } from "@/hooks/useStoreSync";
import { useRoute } from "@/context/RouteContext";
import { SheetProvider, useSheet } from "@/context/SheetContext";
import { ReviewProvider } from "@/context/ReviewContext";
import { useToast } from "@/context/ToastContext";
import { allVersions, keptFence, keptLabel, type KeptFigure, type KeptKind } from "@/lib/visuals/keep";
import { VISUALS, type VisualKind } from "@/lib/visuals/catalogue";
import { size } from "@/lib/files/limits";
import { ago } from "@/lib/util";
import type { StoredBoard } from "@/services/files/db";
import Shell from "../Shell";
import Sheet from "../Sheet";
import Visual from "../visuals/Visual";
import StoredImage from "../visuals/StoredImage";
import ErrorGuard from "../ui/ErrorGuard";
import Icon from "../ui/Icon";
import "@/styles/cards.css";
import "@/styles/figures.css";

/* Excalidraw is half a megabyte for a surface most visits to this page never
   open — the same bargain ChatView makes. */
const BoardSheet = lazy(() => import("../visuals/BoardSheet"));

/** A filter is a kept kind, "board", or everything. The figure kinds are built
 *  from the catalogue rather than typed out, so a new one appears here the day
 *  it is added; "image" and "board" are the two that are not in it. */
type Filter = "all" | KeptKind | "board";

/** One row of the list, whichever of the two things it is. */
interface Row {
  id: string;
  filter: Exclude<Filter, "all">;
  /** What the pill says. */
  kind: string;
  title: string;
  note: string;
  updated: number;
  /** For search. */
  haystack: string;
}

function figureRow(f: KeptFigure): Row {
  return {
    id: f.id,
    filter: f.kind,
    kind: keptLabel(f.kind),
    title: f.title,
    note: f.note,
    updated: f.updated,
    haystack: `${f.title} ${f.note} ${f.conversationTitle || ""} ${f.source}`.toLowerCase()
  };
}

function boardRow(b: StoredBoard): Row {
  return {
    id: b.id,
    filter: "board",
    kind: "Whiteboard",
    title: b.title,
    note: "",
    updated: b.updated,
    haystack: b.title.toLowerCase()
  };
}

function FiguresPage() {
  useDrillStore();
  /* The version, not just the subscription: everything below is derived from
     the two lists, and both hand back a fresh array on every call. */
  const shelf = useStoreSync(figures);
  /* For the "from …" line on a figure's page: a thread's title is written by
     the model a moment after its first reply, so a figure kept from that reply
     recorded "New chat". The live index is the truthful answer. */
  useStoreSync(chatStore);
  const { projectId, figureId, openFigures, openChat } = useRoute();
  const { pane, open } = useSheet();
  const toast = useToast();

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  /* Read again on the way in, not just once at boot: a whiteboard opened from
     chat saves itself on a timer under a title you can still be editing, so
     the cached list is a snapshot of whenever it was last read. Two getAll()s
     against a store of tens of records is cheaper than a wrong title. */
  useEffect(() => {
    void figures.reload();
  }, []);

  const project = store.get().projects[projectId];

  const { kept, boardsHere, rows } = useMemo(() => {
    const k = figures.list(projectId);
    const b = figures.boards(projectId);
    return {
      kept: k,
      boardsHere: b,
      rows: [...k.map(figureRow), ...b.map(boardRow)].sort((x, y) => y.updated - x.updated)
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, shelf]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: rows.length };
    for (const r of rows) c[r.filter] = (c[r.filter] || 0) + 1;
    return c;
  }, [rows]);

  const q = query.trim().toLowerCase();
  const shown = rows.filter((r) => (filter === "all" || r.filter === filter) && (!q || r.haystack.includes(q)));

  /* The id in the URL is a figure, a board, or neither — a link to something
     you have since deleted falls back to the list rather than to a blank page.
     Both are in the route rather than only the figures, so a whiteboard you
     study from is as linkable as everything else on this page. */
  const openFigure = figureId ? figures.get(figureId) : undefined;
  const openBoard = figureId && !openFigure ? figures.board(figureId) : undefined;

  /** A new whiteboard, from here rather than from a conversation — which,
   *  until this section existed, was the only way to get one. The board sheet
   *  saves itself on a timer, so this only has to make it. */
  async function newBoard() {
    const made = boards.newBoard({ projectId, title: "Whiteboard" });
    const ok = await boards.save(made);
    if (!ok) return; // the save alarm has already said so
    figures.noteBoard(made);
    openFigures(made.id);
  }

  if (!project) return null;

  return (
    <Shell current="figures">
      <div className="app-scroll">
        <div className="page figs">
          {openFigure ? (
            <FigureDetail
              figure={openFigure}
              onBack={() => openFigures(null)}
              onMakeCards={(text, label) => open({ name: "ai", source: text, sourceLabel: label })}
              onOpenChat={(id) => openChat(id)}
              onDiscuss={(f) => {
                /* A new thread that already has the figure in it, added the
                   way /map adds its map: a reply, so it is drawn by the figure
                   renderer and is part of the history from the first question
                   you ask about it. Nothing is sent — what to ask is yours. */
                const c = chatStore.create({ projectId, title: f.title.slice(0, 60) });
                /* A picture has no block to put in the thread — its bytes are
                   in the file store and a transcript holds text — so the new
                   thread is opened naming it instead, and the paperclip is
                   how the picture itself gets there if the model can see. */
                const body =
                  f.kind === "image"
                    ? `You kept a picture called “${f.title}”. Attach it with the paperclip if I need to look at it.`
                    : `Here is the ${keptLabel(f.kind).toLowerCase()} you kept — “${f.title}”.\n\n` +
                      "```" +
                      (f.info || keptFence(f.kind)) +
                      "\n" +
                      f.source.replace(/\n$/, "") +
                      "\n```";
                chatStore.addTurn(c, chatStore.makeTurn("assistant", body));
                openChat(c.id);
              }}
              onDelete={(f) => {
                figures.remove(f.id);
                openFigures(null);
                toast(`Removed “${f.title}” from Figures`);
              }}
            />
          ) : (
            <>
              <header className="cards-head">
                <div className="home-folio">
                  {project.name} · {kept.length} figure{kept.length === 1 ? "" : "s"} · {boardsHere.length} whiteboard
                  {boardsHere.length === 1 ? "" : "s"}
                </div>
                <h2>Figures</h2>
                <p className="home-epigraph">
                  {rows.length === 0
                    ? "Nothing kept yet. Any diagram, chart, plot, drawing or canvas in a reply has a Keep button — press it and it lands here, out of the thread that drew it."
                    : "Everything you kept out of a conversation, and every whiteboard you drew."}
                </p>
                <div className="home-rule" />
              </header>

              <section className="home-sec">
                <h3 className="home-sec-h">
                  <span>The shelf</span>
                  <span className="home-sec-note">
                    {shown.length === rows.length ? `${rows.length} kept` : `${shown.length} of ${rows.length}`}
                  </span>
                </h3>

                <div className="cards-tools">
                  <input
                    className="fi"
                    placeholder="search titles, your notes, and the figure itself…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  <button className="btn sm" onClick={() => void newBoard()}>
                    <Icon name="plus" size={13} /> Whiteboard
                  </button>
                </div>

                <div className="cfilters">
                  <button className={"cfilter" + (filter === "all" ? " on" : "")} onClick={() => setFilter("all")}>
                    All
                    <span className="cfilter-n">{counts.all || 0}</span>
                  </button>
                  {VISUALS.map((v) => (
                    <button
                      key={v.kind}
                      className={"cfilter" + (filter === v.kind ? " on" : "")}
                      onClick={() => setFilter(v.kind)}
                      disabled={!counts[v.kind]}
                    >
                      {v.label}
                      <span className="cfilter-n">{counts[v.kind] || 0}</span>
                    </button>
                  ))}
                  {/* The two kinds that are not in the figure catalogue, for
                      the reason keep.ts gives: one is bytes a model returned
                      and the other is a drawing surface, and neither is
                      something a model is taught to write as a fence. */}
                  <button
                    className={"cfilter" + (filter === "image" ? " on" : "")}
                    onClick={() => setFilter("image")}
                    disabled={!counts.image}
                  >
                    Image
                    <span className="cfilter-n">{counts.image || 0}</span>
                  </button>
                  <button
                    className={"cfilter" + (filter === "board" ? " on" : "")}
                    onClick={() => setFilter("board")}
                    disabled={!counts.board}
                  >
                    Whiteboard
                    <span className="cfilter-n">{counts.board || 0}</span>
                  </button>
                </div>

                {shown.length === 0 ? (
                  <p className="home-empty">
                    {rows.length === 0 ? "Keep a figure from a reply, or start a whiteboard." : "Nothing matches."}
                  </p>
                ) : (
                  <ul className="figlist">
                    {shown.map((r) => (
                      <li key={r.id}>
                        <button
                          className="figrow"
                          onClick={() => openFigures(r.id)}
                        >
                          <span className="figrow-txt">
                            <span className="figrow-title">{r.title}</span>
                            {r.note && <span className="figrow-note">{r.note}</span>}
                          </span>
                          <span className="figrow-meta">
                            <span className="fig-kind">{r.kind}</span>
                            <span>{ago(r.updated)}</span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>
      </div>

      <Sheet pane={pane} />

      {openBoard && (
        <ErrorGuard>
          <Suspense fallback={<div className="sheet" />}>
            <BoardSheet
              /* No onSend: there is no conversation here to send it to, and a
                 button that had to invent a thread would be worse than none.
                 Open the board from chat when sending it is the point. */
              board={openBoard}
              onClose={() => {
                openFigures(null);
                /* It saves itself on a timer and again on the way out, so the
                   cached list is a snapshot of before that — reread it or the
                   row keeps the title you just changed away from. */
                void figures.reloadBoards();
              }}
              onDelete={() => {
                figures.removeBoard(openBoard.id);
                openFigures(null);
                toast(`Removed “${openBoard.title}”`);
              }}
            />
          </Suspense>
        </ErrorGuard>
      )}
    </Shell>
  );
}

/* --------------------------------------------------------- one figure -- */

function FigureDetail({
  figure,
  onBack,
  onMakeCards,
  onOpenChat,
  onDiscuss,
  onDelete
}: {
  figure: KeptFigure;
  onBack: () => void;
  onMakeCards: (text: string, label: string) => void;
  onOpenChat: (conversationId: string) => void;
  onDiscuss: (f: KeptFigure) => void;
  onDelete: (f: KeptFigure) => void;
}) {
  const isPicture = figure.kind === "image";
  const versions = allVersions(figure);
  /* Undefined when the conversation has since been deleted — in which case the
     name it had is still worth showing, and the link to it is not. */
  const thread = figure.conversationId ? chatStore.list().find((m) => m.id === figure.conversationId) : undefined;
  /* Opens on the current one, which is the one the title and your note are
     about. The earlier ones are behind the arrow, never gone. */
  const [at, setAt] = useState(versions.length - 1);
  const [title, setTitle] = useState(figure.title);
  const [note, setNote] = useState(figure.note);
  const [confirming, setConfirming] = useState(false);

  /* Following the record rather than holding a copy: keeping a revision from
     chat while this page is open would otherwise leave it showing the old one
     under a version count that had already moved. */
  useEffect(() => {
    setTitle(figure.title);
    setNote(figure.note);
    setAt(allVersions(figure).length - 1);
    /* Only the id and the revision: your own title and note write straight to
       the record, and listening for those too would snap the version you were
       reading back to the newest one the moment you typed in the note box. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [figure.id, figure.updated]);

  const source = versions[Math.min(at, versions.length - 1)]?.source || figure.source;

  return (
    <div className="fig-detail">
      <button className="fig-back" onClick={onBack}>
        <Icon name="chevron" size={12} className="fig-back-chev" />
        <span>All figures</span>
      </button>

      <input
        className="fig-title"
        value={title}
        aria-label="Figure name"
        onChange={(e) => setTitle(e.target.value)}
        /* On blur, like every other field in this app. There is no Save
           button here for the same reason there is none in Settings. */
        onBlur={() => figures.rename(figure.id, title)}
      />

      <div className="fig-prov">
        <span className="fig-kind">{keptLabel(figure.kind)}</span>
        <span>kept {ago(figure.created)}</span>
        {figure.updated !== figure.created && <span>revised {ago(figure.updated)}</span>}
        {thread ? (
          <button onClick={() => onOpenChat(thread.id)}>from “{thread.title}”</button>
        ) : figure.conversationTitle ? (
          <span>from “{figure.conversationTitle}” — since deleted</span>
        ) : null}
        {versions.length > 1 && (
          <span className="fig-vers">
            <button onClick={() => setAt(Math.max(0, at - 1))} disabled={at === 0} aria-label="Earlier version">
              ‹
            </button>
            v{at + 1}/{versions.length}
            <button onClick={() => setAt(Math.min(versions.length - 1, at + 1))} disabled={at >= versions.length - 1} aria-label="Later version">
              ›
            </button>
          </span>
        )}
      </div>

      {/* The same renderer the conversation uses, on the same block — which is
          why there is nothing here that can drift from how it looked in the
          reply. No `keep`: it is already kept. A picture has no block, so its
          bytes come from the file store instead. */}
      <ErrorGuard fallback={<div className="vis-error">This figure could not be shown.</div>}>
        {isPicture && figure.image ? (
          <figure className="vis vis-image">
            <StoredImage fileId={figure.image.fileId} thumb={figure.image.thumb} alt={figure.title} className="vis-photo" />
            <figcaption className="vis-foot">
              {figure.image.w}×{figure.image.h} · {size(figure.image.size)}
            </figcaption>
          </figure>
        ) : (
          <Visual
            key={`${figure.id}:${at}`}
            block={{ kind: figure.kind as VisualKind, lang: keptFence(figure.kind), info: figure.info, source }}
            onMakeCards={(text) => onMakeCards(text, `the figure “${figure.title}”`)}
          />
        )}
      </ErrorGuard>

      <div className="fig-why">
        <label className="label" htmlFor="fig-why">
          Why you kept it
        </label>
        <textarea
          id="fig-why"
          className="fi"
          value={note}
          placeholder="what this one showed you — the thing you would want to read first in six months"
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => figures.setNote(figure.id, note)}
        />
      </div>

      <div className="fig-acts">
        <button className="btn sm" onClick={() => onDiscuss(figure)}>
          Ask about this
        </button>
        <button
          className="btn sm"
          /* A picture's source is a file id, which would teach a card writer
             nothing — what it has instead is the title, which is what was
             asked for when it was drawn. */
          onClick={() =>
            onMakeCards(
              isPicture
                ? `A picture the learner kept: ${figure.title}${figure.note ? `. Their note: ${figure.note}` : ""}`
                : `${keptLabel(figure.kind)} — ${figure.title}\n\n${source}`,
              `the figure “${figure.title}”`
            )
          }
        >
          Make cards
        </button>
        {confirming ? (
          <>
            <button className="btn sm danger" onClick={() => onDelete(figure)}>
              Remove it — including {versions.length} version{versions.length === 1 ? "" : "s"}
            </button>
            <button className="btn sm" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button className="btn sm" onClick={() => setConfirming(true)}>
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

export default function FiguresView() {
  return (
    <SheetProvider>
      <ReviewProvider>
        <FiguresPage />
      </ReviewProvider>
    </SheetProvider>
  );
}
