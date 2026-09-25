/* ============================================================================
 * ModelBrowser — choosing a model out of six hundred, as a decision rather
 * than a guess.
 *
 * The picker it replaces was a search box, five category pills and a list of
 * raw ids. It could not answer the questions people actually bring to it:
 * *which of these is the good one*, *what does it cost for what I am about to
 * do*, *can it see my screenshot*, *is there something newer*. And it could
 * only ever show text models, because that is all the catalogue was asked for
 * (see services/pricing.ts). This is built around those questions:
 *
 *  - **Names, not ids.** "Claude Sonnet 4.5 · Anthropic" is what a person
 *    recognises; the id is in the detail card, one click from the clipboard.
 *  - **A card for the one you are looking at.** Price in and out (and the
 *    rate above 200k tokens, which is the surprise on a long-PDF bill),
 *    context, the longest reply, what it can take and make, when it came out,
 *    what it knows up to, in the catalogue's own words. Beside the list when
 *    there is room; under the row when there is not (a container query, so it
 *    is the picker's own width that decides, not the window's).
 *  - **Filters that are questions.** Thinks, Sees images, Reads PDFs, Draws,
 *    Long context, Free, New — combinable, and a provider menu, and sorting by
 *    what you are optimising for.
 *  - **Your own shortlist first.** Pinned models, then recent ones, then the
 *    rest by provider — providers ordered by who released something most
 *    recently, so there is no hand-kept list of "important vendors" to rot.
 *  - **One component for every kind.** Chat, image, video, voices and
 *    transcription are the same browser with different facts: a voice shows
 *    its voices and its price per thousand characters, a video model its
 *    durations, resolutions and price per second.
 *  - **Keyboard all the way.** Focus stays in the search box; arrows move,
 *    Enter chooses, and an id the list has never heard of is still yours to
 *    type — a local server's models are not discoverable everywhere.
 *
 * Nothing here decides capability from a name. Every fact is the catalogue's,
 * and a model the catalogue has never heard of (a local one) is shown plainly
 * with nothing asserted about it — unknown is not no.
 * ========================================================================== */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as pricing from "@/services/pricing";
import * as M from "@/lib/models";
import { videoRate } from "@/lib/mediaCaps";
import { recentModels, recordModelUse } from "@/lib/recentModels";
import * as favs from "@/lib/favoriteModels";
import { useStoreSync } from "@/hooks/useStoreSync";
import { ago } from "@/lib/util";
import Icon, { type IconName } from "./Icon";
import type { BackendType } from "@/types";
import type { ModelKind, ModelPrice } from "@/types/chat";

/** Whether this model returns pictures, from the catalogue's output
 *  modalities. Absent means no, not unknown: a model that cannot be shown to
 *  draw must not be offered under a promise of drawing. */
export function canDraw(id: string): boolean {
  return M.draws(pricing.catalogueEntry(id));
}

/* ------------------------------------------------------------ filters -- */

interface Filter {
  id: string;
  label: string;
  icon?: IconName;
  test: (e: ModelPrice | undefined, id: string) => boolean;
}

const LONG = 200_000;

function resolutions(id: string): string[] {
  return pricing.videoCaps(id)?.resolutions || [];
}

const FILTERS: Record<ModelKind, Filter[]> = {
  chat: [
    { id: "think", label: "Thinks", icon: "brain", test: (e) => !!e?.reasoning },
    { id: "vision", label: "Sees images", icon: "eye", test: (e) => M.canSee(e) },
    { id: "files", label: "Reads PDFs", icon: "paperclip", test: (e) => M.readsFiles(e) },
    { id: "draw", label: "Draws", icon: "image", test: (e) => M.draws(e) },
    { id: "long", label: "Long context", test: (e) => (e?.contextLength || 0) >= LONG },
    { id: "free", label: "Free", test: (e) => M.isFree(e) },
    { id: "new", label: "New", test: (e) => M.isNew(e) }
  ],
  image: [
    { id: "edit", label: "Edits a picture", icon: "eye", test: (_e, id) => !!pricing.imageCaps(id)?.refs || M.canSee(_e) },
    { id: "talks", label: "Writes too", icon: "bubble", test: (e) => !!e?.kinds?.includes("chat") },
    { id: "free", label: "Free", test: (e) => M.isFree(e) },
    { id: "new", label: "New", test: (e) => M.isNew(e) }
  ],
  video: [
    { id: "frame", label: "From a picture", icon: "image", test: (_e, id) => !!pricing.videoCaps(id)?.frames?.includes("first_frame") },
    { id: "audio", label: "With sound", icon: "speaker", test: (_e, id) => !!pricing.videoCaps(id)?.audio },
    { id: "hd", label: "1080p or more", test: (_e, id) => resolutions(id).some((r) => /1080|2k|4k/i.test(r)) },
    { id: "new", label: "New", test: (e) => M.isNew(e) }
  ],
  speech: [
    { id: "free", label: "Free", test: (e) => M.isFree(e) },
    { id: "many", label: "10+ voices", icon: "speaker", test: (e) => (e?.voices?.length || 0) >= 10 },
    { id: "new", label: "New", test: (e) => M.isNew(e) }
  ],
  transcription: [
    { id: "free", label: "Free", test: (e) => M.isFree(e) || e?.perSecond === 0 },
    { id: "new", label: "New", test: (e) => M.isNew(e) }
  ],
  embedding: [],
  other: []
};

const SORTS: Record<ModelKind, { id: M.SortId; label: string }[]> = {
  chat: [
    { id: "provider", label: "By provider" },
    { id: "newest", label: "Newest" },
    { id: "cheapest", label: "Cheapest" },
    { id: "context", label: "Largest context" },
    { id: "name", label: "A–Z" }
  ],
  image: [
    { id: "provider", label: "By provider" },
    { id: "newest", label: "Newest" },
    { id: "cheapest", label: "Cheapest" },
    { id: "name", label: "A–Z" }
  ],
  video: [
    { id: "provider", label: "By provider" },
    { id: "newest", label: "Newest" },
    { id: "cheapest", label: "Cheapest" },
    { id: "name", label: "A–Z" }
  ],
  speech: [
    { id: "cheapest", label: "Cheapest" },
    { id: "provider", label: "By provider" },
    { id: "newest", label: "Newest" },
    { id: "name", label: "A–Z" }
  ],
  transcription: [
    { id: "cheapest", label: "Cheapest" },
    { id: "provider", label: "By provider" },
    { id: "newest", label: "Newest" },
    { id: "name", label: "A–Z" }
  ],
  embedding: [{ id: "provider", label: "By provider" }],
  other: [{ id: "provider", label: "By provider" }]
};

const NOUN: Record<ModelKind, string> = {
  chat: "models",
  image: "image models",
  video: "video models",
  speech: "voice models",
  transcription: "transcription models",
  embedding: "embedding models",
  other: "models"
};

/* --------------------------------------------------------------- facts -- */

/** No hue is reserved for a provider, so one is picked deterministically
 *  from the small palette tokens.css defines — an initial-letter avatar,
 *  expressed as a class rather than an inline colour per the tokens rule. */
function hueOf(slug: string): number {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  return h % 5;
}

function titleOf(id: string, e: ModelPrice | undefined): string {
  return e?.title || M.tailOf(id);
}

function vendorOf(id: string, e: ModelPrice | undefined): string {
  return e?.vendor || M.splitName(id).vendor;
}

function span(nums: number[] | undefined, unit: string): string {
  if (!nums?.length) return "";
  if (nums.length === 1) return `${nums[0]}${unit}`;
  const contiguous = nums.every((n, i) => i === 0 || n - nums[i - 1] === 1);
  if (contiguous) return `${nums[0]}–${nums[nums.length - 1]}${unit}`;
  if (nums.length <= 4) return nums.slice(0, -1).join(", ") + " or " + nums[nums.length - 1] + unit;
  return `${nums[0]}–${nums[nums.length - 1]}${unit}`;
}

function topResolution(list: string[] | undefined): string {
  if (!list?.length) return "";
  const rank = (r: string) => {
    const k = /(\d+)\s*k/i.exec(r);
    if (k) return Number(k[1]) * 1000;
    const p = /(\d+)p/i.exec(r);
    return p ? Number(p[1]) : 0;
  };
  return [...list].sort((a, b) => rank(b) - rank(a))[0];
}

/** The second line of a row: the facts that decide a choice at a glance. */
function subLine(kind: ModelKind, id: string, e: ModelPrice | undefined, backend: BackendType | ""): string {
  const vendor = vendorOf(id, e);
  const bits: string[] = [vendor];
  if (kind === "chat") {
    if (e?.contextLength) bits.push(M.tokens(e.contextLength) + " ctx");
    const p = backendPrice(backend, id, e);
    if (p) bits.push(p);
  } else if (kind === "video") {
    const caps = pricing.videoCaps(id);
    if (caps?.durations) bits.push(span(caps.durations, "s"));
    const res = topResolution(caps?.resolutions);
    if (res) bits.push("up to " + res);
    const rate = videoRate(caps);
    if (rate != null) bits.push("from " + M.money(rate) + "/s");
    if (caps?.needsVideo) bits.push("edits a video you give it");
  } else if (kind === "image") {
    /* What it can do, then what a picture costs once that is known. The
       catalogue prices drawing per million output tokens, which is true and
       tells nobody anything; the per-picture price comes from the model's
       endpoints, fetched when its card is looked at. */
    const caps = pricing.imageCaps(id);
    if (caps?.resolutions?.length) bits.push(caps.resolutions.length > 1 ? `${caps.resolutions[0]}–${caps.resolutions[caps.resolutions.length - 1]}` : caps.resolutions[0]);
    const shapes = caps?.aspects?.filter((a) => a !== "auto").length || 0;
    if (shapes) bits.push(`${shapes} shape${shapes === 1 ? "" : "s"}`);
    if (caps?.refs) bits.push("edits");
    const rate = pricing.imageRatesNow(id)?.[0];
    if (rate) bits.push(`${M.money(rate.usd)}/${rate.unit}`);
    else if (M.isFree(e)) bits.push("free");
  } else if (kind === "speech") {
    const n = e?.voices?.length || 0;
    bits.push(n ? `${n} voice${n === 1 ? "" : "s"}` : "voice by id");
    const p = M.priceLine(e, "speech");
    if (p) bits.push(p);
  } else {
    const p = M.priceLine(e, kind);
    if (p) bits.push(p);
  }
  return bits.filter(Boolean).join(" · ");
}

/** The price a chat row shows — the backend's, not the catalogue's, because
 *  a price is a claim about money and Groq's free tier is not OpenRouter's
 *  rate (see priceForModel). */
function backendPrice(backend: BackendType | "", id: string, e: ModelPrice | undefined): string {
  if (e?.variable) return "price varies";
  const p = backend ? pricing.priceForModel(backend, id) : e;
  if (!p) return "";
  if (p.prompt === 0 && p.completion === 0) return "free";
  return M.money(p.prompt) + " / " + M.money(p.completion);
}

function capIcons(kind: ModelKind, id: string, e: ModelPrice | undefined): { icon: IconName; label: string }[] {
  const out: { icon: IconName; label: string }[] = [];
  if (kind === "chat") {
    if (e?.reasoning) out.push({ icon: "brain", label: "Can think before answering" });
    if (M.canSee(e)) out.push({ icon: "eye", label: "Sees images" });
    if (M.readsFiles(e)) out.push({ icon: "paperclip", label: "Reads PDFs as files" });
    if (M.draws(e)) out.push({ icon: "image", label: "Can return a picture" });
  } else if (kind === "image") {
    if (pricing.imageCaps(id)?.refs || M.canSee(e)) out.push({ icon: "eye", label: "Works from a picture you give it" });
    if (e?.kinds?.includes("chat")) out.push({ icon: "bubble", label: "Writes as well as draws" });
  } else if (kind === "video") {
    const c = pricing.videoCaps(id);
    if (c?.frames?.includes("first_frame")) out.push({ icon: "image", label: "Can start from a picture" });
    if (c?.audio) out.push({ icon: "speaker", label: "Makes its own sound" });
  }
  return out;
}

/* ------------------------------------------------------------- detail -- */

function Fact({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="mb-fact">
      <dt>{k}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function monthYear(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

export function ModelDetail({
  id,
  kind,
  backend,
  chosen,
  onChoose
}: {
  id: string;
  kind: ModelKind;
  backend: BackendType | "";
  chosen: boolean;
  onChoose: (id: string) => void;
}) {
  useStoreSync(favs);
  const e = pricing.catalogueEntry(id);
  const pinned = favs.isFavorite(id);
  const [copied, setCopied] = useState(false);
  const [rates, setRates] = useState<pricing.ImageRate[] | null | undefined>(undefined);

  useEffect(() => {
    setCopied(false);
    setRates(undefined);
    if (kind !== "image" || backend !== "openrouter") return;
    let live = true;
    void pricing.loadImageRates(id).then((r) => live && setRates(r));
    return () => {
      live = false;
    };
  }, [id, kind, backend]);

  const facts: ReactNode[] = [];
  if (kind === "chat") {
    const p = backend ? pricing.priceForModel(backend, id) : e;
    if (e?.variable) facts.push(<Fact key="p" k="Price">varies with the model it routes to</Fact>);
    else if (p && p.prompt === 0 && p.completion === 0) facts.push(<Fact key="p" k="Price">free</Fact>);
    else if (p) {
      facts.push(
        <Fact key="in" k="Input">
          {M.money(p.prompt)} <small>per million tokens</small>
        </Fact>,
        <Fact key="out" k="Output">
          {M.money(p.completion)} <small>per million tokens</small>
        </Fact>
      );
      if (e?.tiered)
        facts.push(
          <Fact key="tier" k={`Above ${M.tokens(e.tiered.above)}`}>
            {M.money(e.tiered.prompt)} in · {M.money(e.tiered.completion)} out
          </Fact>
        );
    } else if (backend && backend !== "openrouter") facts.push(<Fact key="p" k="Price">not published for this backend</Fact>);
    if (e?.contextLength) facts.push(<Fact key="ctx" k="Context">{e.contextLength.toLocaleString()} tokens</Fact>);
    if (e?.maxOutput) facts.push(<Fact key="max" k="Longest reply">{e.maxOutput.toLocaleString()} tokens</Fact>);
    if (e?.webSearch) facts.push(<Fact key="web" k="Web search">{M.money(e.webSearch)} a search</Fact>);
  } else if (kind === "image") {
    const caps = pricing.imageCaps(id);
    if (rates?.length) {
      facts.push(
        <Fact key="rate" k="Price">
          {rates
            .slice(0, 3)
            .map((r) => `${M.money(r.usd)} per ${r.unit}${r.variant ? ` (${r.variant})` : ""}`)
            .join(" · ")}
        </Fact>
      );
    } else if (M.isFree(e)) facts.push(<Fact key="rate" k="Price">free</Fact>);
    else if (e?.imageOutput) facts.push(<Fact key="rate" k="Price">{M.money(e.imageOutput)} per million image tokens</Fact>);
    if (caps?.aspects) facts.push(<Fact key="ar" k="Shapes">{caps.aspects.filter((a) => a !== "auto").join("  ")}</Fact>);
    if (caps?.resolutions) facts.push(<Fact key="res" k="Sizes">{caps.resolutions.join("  ")}</Fact>);
    if (caps?.refs) facts.push(<Fact key="refs" k="References">up to {caps.refs.max} picture{caps.refs.max === 1 ? "" : "s"}</Fact>);
    if (caps?.n && caps.n.max > 1) facts.push(<Fact key="n" k="Per request">up to {caps.n.max} pictures</Fact>);
  } else if (kind === "video") {
    const caps = pricing.videoCaps(id);
    const rate = videoRate(caps);
    if (rate != null) facts.push(<Fact key="rate" k="Price">from {M.money(rate)} a second</Fact>);
    else if (caps && Object.keys(caps.skus).some((k) => k.startsWith("video_tokens")))
      facts.push(<Fact key="rate" k="Price">per video token — shown once it is made</Fact>);
    if (caps?.durations) facts.push(<Fact key="dur" k="Length">{span(caps.durations, " seconds")}</Fact>);
    if (caps?.resolutions) facts.push(<Fact key="res" k="Resolution">{caps.resolutions.join("  ")}</Fact>);
    if (caps?.aspects) facts.push(<Fact key="ar" k="Shapes">{caps.aspects.join("  ")}</Fact>);
    if (caps?.frames)
      facts.push(
        <Fact key="fr" k="Pictures">
          {caps.frames.includes("last_frame") ? "can start and end on a picture" : "can start from a picture"}
        </Fact>
      );
    if (caps?.audio) facts.push(<Fact key="au" k="Sound">makes its own soundtrack</Fact>);
    if (caps?.needsVideo) facts.push(<Fact key="nv" k="Needs">a video to work on — not a prompt alone</Fact>);
  } else if (kind === "speech") {
    const n = e?.voices?.length || 0;
    facts.push(<Fact key="p" k="Price">{M.priceLine(e, "speech") || "not published"}</Fact>);
    facts.push(
      <Fact key="v" k="Voices">
        {n ? `${n} — ${e!.voices!.slice(0, 6).join(", ")}${n > 6 ? "…" : ""}` : "none listed; it takes a voice id from its own library"}
      </Fact>
    );
  } else if (kind === "transcription") {
    facts.push(<Fact key="p" k="Price">{M.priceLine(e, "transcription") || "not published"}</Fact>);
  }
  if (e?.created) facts.push(<Fact key="rel" k="Released">{monthYear(e.created)}</Fact>);
  if (e?.cutoff) facts.push(<Fact key="cut" k="Knows up to">{e.cutoff}</Fact>);
  if (e?.expires) facts.push(<Fact key="exp" k="Retires">{e.expires}</Fact>);

  const slug = M.vendorSlug(id);
  const caps = capIcons(kind, id, e);

  return (
    <div className="mb-card">
      <div className="mb-card-head">
        <span className="mb-av lg" data-hue={hueOf(slug)} aria-hidden="true">
          {vendorOf(id, e).charAt(0).toUpperCase()}
        </span>
        <div className="mb-card-name">
          <strong>{titleOf(id, e)}</strong>
          <span>{vendorOf(id, e)}</span>
        </div>
      </div>
      <button
        type="button"
        className="mb-id"
        title="Copy the id"
        onClick={() => {
          void navigator.clipboard?.writeText(id).then(() => setCopied(true));
        }}
      >
        <code>{id}</code>
        <Icon name={copied ? "check" : "copy"} size={12} />
      </button>

      {(caps.length > 0 || M.isNew(e) || M.isFree(e)) && (
        <div className="mb-tags">
          {M.isNew(e) && <span className="mb-tag new">New</span>}
          {M.isFree(e) && <span className="mb-tag free">Free</span>}
          {caps.map((c) => (
            <span key={c.icon} className="mb-tag">
              <Icon name={c.icon} size={11} />
              {c.label}
            </span>
          ))}
        </div>
      )}

      {e?.about ? (
        <p className="mb-about">{e.about}</p>
      ) : (
        !e && <p className="mb-about muted">Not in OpenRouter's catalogue — nothing is known about it here, which is normal for a local model.</p>
      )}

      {facts.length > 0 && <dl className="mb-facts">{facts}</dl>}

      <div className="mb-card-acts">
        <button type="button" className="btn sm pri" onClick={() => onChoose(id)} disabled={chosen}>
          {chosen ? "In use" : "Use this model"}
        </button>
        <button type="button" className={"btn sm" + (pinned ? " on" : "")} onClick={() => favs.toggleFavorite(id)}>
          <Icon name={pinned ? "star-filled" : "star"} size={12} />
          {pinned ? "Pinned" : "Pin"}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- browser -- */

export interface ModelBrowserProps {
  /** Which kind of model is being chosen. Decides the filters, the facts on
   *  each row and which ids qualify at all. Defaults to chat. */
  kind?: ModelKind;
  /** Every id this backend serves, from listModels(). Omit to take the
   *  catalogue's list for the kind — which is right for OpenRouter's images,
   *  videos, voices and transcribers. */
  models?: string[];
  loading?: boolean;
  backend: BackendType | "";
  /** The id currently in force. */
  value: string;
  onChoose: (id: string) => void;
  autoFocus?: boolean;
  /** Narrow further than the kind does. */
  restrict?: (id: string) => boolean;
  /** Said when the restriction leaves nothing. */
  restrictNote?: string;
  /** An id the list does not have can be typed and chosen with Enter. On by
   *  default: a local server's models are not discoverable everywhere. */
  allowTyped?: boolean;
  /** `models` is a purpose-built list for this kind — Groq's transcription
   *  models, say — so an id the catalogue does not know is still one of them.
   *  Without it, an unknown id counts as a chat model, which is what a
   *  backend's general list is full of. */
  trustList?: boolean;
}

type Section = { key: string; title: string; note?: string; ids: string[] };

export default function ModelBrowser({
  kind = "chat",
  models,
  loading,
  backend,
  value,
  onChoose,
  autoFocus,
  restrict,
  restrictNote,
  allowTyped = true,
  trustList
}: ModelBrowserProps) {
  const catVersion = useStoreSync(pricing);
  useStoreSync(favs);
  const [query, setQuery] = useState("");
  const [on, setOn] = useState<string[]>([]);
  const [vendor, setVendor] = useState("");
  const [sort, setSort] = useState<M.SortId>(SORTS[kind][0].id);
  const [active, setActive] = useState<string>("");
  const [expanded, setExpanded] = useState<string>("");
  const [refreshing, setRefreshing] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** Set by the keyboard, cleared by the mouse: only a keyboard move scrolls
   *  the list, or hovering near an edge would drag it under the pointer. */
  const keyboardMove = useRef(false);

  useEffect(() => {
    void pricing.loadPricing();
    if (kind === "image") void pricing.loadImageCaps();
    if (kind === "video") void pricing.loadVideoCaps();
  }, [kind]);

  const entry = (id: string) => pricing.catalogueEntry(id);

  /* Which ids qualify at all. A backend's own list, narrowed to the kind; or
     for OpenRouter-only kinds, the catalogue's. An id the catalogue has never
     heard of is a chat model — it is what a local server serves. */
  const pool = useMemo(() => {
    const listed = models && models.length ? models : null;
    let ids: string[];
    if (listed) {
      ids = listed.filter((id) => {
        const k = entry(id)?.kinds;
        return k && k.length ? k.includes(kind) : trustList || kind === "chat";
      });
    } else if (backend === "openrouter" || kind !== "chat") {
      ids = pricing.modelsOfKind(kind).map((m) => m.id);
    } else ids = [];
    if (kind === "video") ids = ids.filter((id) => !pricing.videoCaps(id)?.needsVideo);
    if (restrict) ids = ids.filter(restrict);
    return [...new Set(ids)];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models, kind, backend, restrict, trustList, catVersion]);

  const vendors = useMemo(() => {
    const by = new Map<string, { label: string; n: number }>();
    for (const id of pool) {
      const slug = M.vendorSlug(id);
      const hit = by.get(slug);
      if (hit) hit.n++;
      else by.set(slug, { label: vendorOf(id, entry(id)), n: 1 });
    }
    return [...by.entries()].sort((a, b) => b[1].n - a[1].n || a[1].label.localeCompare(b[1].label));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool, catVersion]);

  const filters = FILTERS[kind].filter((f) => on.includes(f.id));
  const q = query.trim();
  const browsing = !q && !filters.length && !vendor;

  const matched = useMemo(() => {
    const list = pool.filter((id) => {
      const e = entry(id);
      if (vendor && M.vendorSlug(id) !== vendor) return false;
      for (const f of filters) if (!f.test(e, id)) return false;
      return !q || M.matches(e ? e : { id }, q);
    });
    if (q) {
      return list.sort(
        (a, b) =>
          M.relevance(entry(b) || { id: b }, q) - M.relevance(entry(a) || { id: a }, q) ||
          (entry(b)?.created || 0) - (entry(a)?.created || 0)
      );
    }
    const by = (f: (id: string) => number, dir = 1) => list.sort((a, b) => dir * (f(a) - f(b)) || a.localeCompare(b));
    if (sort === "newest") by((id) => entry(id)?.created || 0, -1);
    else if (sort === "cheapest")
      by((id) => (kind === "video" ? videoRate(pricing.videoCaps(id)) ?? Infinity : M.sortPrice(entry(id), kind)));
    else if (sort === "context") by((id) => entry(id)?.contextLength || 0, -1);
    else if (sort === "name") list.sort((a, b) => titleOf(a, entry(a)).localeCompare(titleOf(b, entry(b))));
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool, q, vendor, on, sort, catVersion]);

  const sections: Section[] = useMemo(() => {
    const out: Section[] = [];
    if (browsing) {
      const have = new Set(pool);
      const pinned = favs.favoriteModels().filter((id) => have.has(id));
      const recent = recentModels()
        .filter((id) => have.has(id) && !pinned.includes(id))
        .slice(0, 5);
      if (pinned.length) out.push({ key: "pinned", title: "Pinned", ids: pinned });
      if (recent.length) out.push({ key: "recent", title: "Recent", ids: recent });
    }
    if (sort === "provider" && !q) {
      for (const g of M.groupByVendor(matched, entry)) out.push({ key: "v:" + g.slug, title: g.label, note: String(g.ids.length), ids: g.ids });
    } else if (matched.length) {
      out.push({ key: "all", title: q ? "Results" : SORTS[kind].find((s) => s.id === sort)?.label || "Models", note: String(matched.length), ids: matched });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matched, browsing, sort, q, pool, favs.getVersion()]);

  /** Every row in the order it is drawn, as "section:id" — a pinned model is
   *  also in its provider's group, and each appearance is its own stop. */
  const order = useMemo(() => sections.flatMap((s) => s.ids.map((id) => s.key + "|" + id)), [sections]);

  /* A new query or filter puts the top result under Enter; opening the
     picker puts the model in use there, so the card starts on it. */
  useEffect(() => {
    if (!order.length) {
      setActive("");
      return;
    }
    if (q || filters.length || vendor) setActive(order[0]);
    else {
      const current = order.find((k) => k.endsWith("|" + value));
      setActive((prev) => (prev && order.includes(prev) ? prev : current || order[0]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, on, vendor, sort, order.length]);

  useEffect(() => {
    if (!keyboardMove.current || !active) return;
    keyboardMove.current = false;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(active)}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const activeId = active ? active.slice(active.indexOf("|") + 1) : "";
  const detailId = activeId || (pool.includes(value) ? value : "") || matched[0] || "";

  function choose(id: string) {
    const v = id.trim();
    if (!v) return;
    recordModelUse(v);
    onChoose(v);
  }

  function move(delta: number) {
    if (!order.length) return;
    const i = order.indexOf(active);
    const next = i < 0 ? 0 : Math.max(0, Math.min(order.length - 1, i + delta));
    keyboardMove.current = true;
    setActive(order[next]);
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "PageDown") {
      e.preventDefault();
      move(8);
    } else if (e.key === "PageUp") {
      e.preventDefault();
      move(-8);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeId && order.length) choose(activeId);
      else if (allowTyped && q) choose(q);
    }
  }

  function toggle(fid: string) {
    setOn((prev) => (prev.includes(fid) ? prev.filter((x) => x !== fid) : [...prev, fid]));
  }

  function clearAll() {
    setQuery("");
    setOn([]);
    setVendor("");
    inputRef.current?.focus();
  }

  const fetched = pricing.catalogueAt();
  const showSort = SORTS[kind].length > 1;

  function row(section: Section, id: string) {
    const key = section.key + "|" + id;
    const e = entry(id);
    const isOn = id === value;
    const isActive = key === active;
    const pinned = favs.isFavorite(id);
    const caps = capIcons(kind, id, e);
    return (
      <div key={key} className="mb-rowwrap">
        <div
          role="option"
          aria-selected={isOn}
          id={"mb-" + key}
          data-key={key}
          className={"mb-row" + (isOn ? " on" : "") + (isActive ? " active" : "")}
          onMouseMove={() => {
            if (!isActive) setActive(key);
          }}
          onClick={() => choose(id)}
        >
          <span className="mb-av" data-hue={hueOf(M.vendorSlug(id))} aria-hidden="true">
            {vendorOf(id, e).charAt(0).toUpperCase()}
          </span>
          <span className="mb-main">
            <span className="mb-name">
              <span className="mb-title">{titleOf(id, e)}</span>
              {M.isNew(e) && <span className="mb-new">new</span>}
            </span>
            <span className="mb-sub">{subLine(kind, id, e, backend)}</span>
          </span>
          {caps.length > 0 && (
            <span className="mb-caps">
              {caps.map((c) => (
                <span key={c.icon} title={c.label}>
                  <Icon name={c.icon} size={13} />
                </span>
              ))}
            </span>
          )}
          <button
            type="button"
            tabIndex={-1}
            className={"mb-star" + (pinned ? " on" : "")}
            title={pinned ? "Unpin" : "Pin to the top"}
            aria-label={pinned ? "Unpin" : "Pin to the top"}
            onClick={(ev) => {
              ev.stopPropagation();
              favs.toggleFavorite(id);
            }}
          >
            <Icon name={pinned ? "star-filled" : "star"} size={13} />
          </button>
          <button
            type="button"
            tabIndex={-1}
            className={"mb-more" + (expanded === key ? " on" : "")}
            title="Details"
            aria-label="Details"
            onClick={(ev) => {
              ev.stopPropagation();
              setExpanded((x) => (x === key ? "" : key));
            }}
          >
            <Icon name="info" size={14} />
          </button>
          {isOn && <Icon name="check" size={14} className="mb-check" />}
        </div>
        {expanded === key && (
          <div className="mb-inline">
            <ModelDetail id={id} kind={kind} backend={backend} chosen={isOn} onChoose={choose} />
          </div>
        )}
      </div>
    );
  }

  const nothing = !loading && !order.length;

  return (
    <div className="mb">
      <div className="mb-top">
        <div className="mb-search">
          <Icon name="search" size={14} />
          <input
            ref={inputRef}
            autoFocus={autoFocus}
            value={query}
            placeholder={
              loading && !pool.length
                ? "Loading the list…"
                : pool.length
                  ? `Search ${pool.length} ${NOUN[kind]}${allowTyped ? ", or type any id" : ""}`
                  : allowTyped
                    ? "Type a model id"
                    : "Search"
            }
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            role="combobox"
            aria-expanded="true"
            aria-controls="mb-list"
            aria-activedescendant={active ? "mb-" + active : undefined}
            spellCheck={false}
            autoComplete="off"
          />
          {query && (
            <button type="button" className="mb-x" aria-label="Clear the search" onClick={() => setQuery("")}>
              <Icon name="close" size={12} />
            </button>
          )}
        </div>

        {(FILTERS[kind].length > 0 || vendors.length > 1 || showSort) && (
          <div className="mb-controls">
            <div className="mb-chips" role="group" aria-label="Filters">
              {FILTERS[kind].map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className={"mb-chip" + (on.includes(f.id) ? " on" : "")}
                  aria-pressed={on.includes(f.id)}
                  onClick={() => toggle(f.id)}
                >
                  {f.icon && <Icon name={f.icon} size={12} />}
                  {f.label}
                </button>
              ))}
            </div>
            <div className="mb-selects">
              {vendors.length > 1 && (
                <label className="mb-select">
                  <span className="sr-only">Provider</span>
                  <select value={vendor} onChange={(e) => setVendor(e.target.value)}>
                    <option value="">All providers</option>
                    {vendors.map(([slug, v]) => (
                      <option key={slug} value={slug}>
                        {v.label} ({v.n})
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {showSort && (
                <label className="mb-select">
                  <span className="sr-only">Sort</span>
                  <select value={sort} onChange={(e) => setSort(e.target.value as M.SortId)}>
                    {SORTS[kind].map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="mb-body">
        <div className="mb-list" id="mb-list" role="listbox" ref={listRef} onMouseLeave={() => (keyboardMove.current = false)}>
          {loading && !pool.length && (
            <div className="mb-skel" aria-label="Loading">
              {[0, 1, 2, 3, 4].map((i) => (
                <i key={i} />
              ))}
            </div>
          )}
          {nothing && (
            <div className="mb-empty">
              {pool.length === 0 ? (
                restrictNote ? (
                  <p>{restrictNote}</p>
                ) : (
                  <p>
                    {backend && backend !== "openrouter" && kind === "chat"
                      ? "This backend did not list its models."
                      : "The model list could not be loaded."}
                    {allowTyped ? " Type an id and press Enter." : ""}
                  </p>
                )
              ) : (
                <>
                  <p>
                    Nothing matches{q ? ` “${q}”` : ""}
                    {filters.length ? " with those filters" : ""}.
                  </p>
                  {allowTyped && q && <p className="mb-hint">Press Enter to use “{q}” as a model id.</p>}
                  {(filters.length > 0 || vendor || q) && (
                    <button type="button" className="btn sm" onClick={clearAll}>
                      Clear search and filters
                    </button>
                  )}
                </>
              )}
            </div>
          )}
          {sections.map((s) => (
            <div key={s.key} className="mb-group" role="group" aria-label={s.title}>
              <div className="mb-group-h">
                <span>{s.title}</span>
                {s.note && s.key !== "pinned" && s.key !== "recent" && <span className="mb-count">{s.note}</span>}
              </div>
              {s.ids.map((id) => row(s, id))}
            </div>
          ))}
        </div>

        <aside className="mb-side" aria-live="polite">
          {detailId ? (
            <ModelDetail id={detailId} kind={kind} backend={backend} chosen={detailId === value} onChoose={choose} />
          ) : (
            <p className="mb-side-empty">Point at a model to see what it costs and what it can do.</p>
          )}
        </aside>
      </div>

      <div className="mb-foot">
        <span>
          {order.length ? `${matched.length} of ${pool.length}` : ""}
          {fetched ? ` · updated ${ago(fetched)}` : ""}
        </span>
        <span className="mb-keys">↑↓ move · ↵ choose</span>
        {fetched > 0 && (
          <button
            type="button"
            className="mb-refresh"
            disabled={refreshing}
            title="Fetch the catalogue again — prices and new models"
            onClick={() => {
              setRefreshing(true);
              void pricing.refreshCatalogue().finally(() => setRefreshing(false));
            }}
          >
            <Icon name="refresh" size={12} />
          </button>
        )}
      </div>
    </div>
  );
}
