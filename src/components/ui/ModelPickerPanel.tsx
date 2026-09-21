/* ============================================================================
 * ModelPickerPanel — the structured innards shared by every model picker:
 * search, recents, capability/price filters, grouped by provider.
 *
 * There used to be two of these, both naive in the same way: ModelChip's
 * popover was a flat `models.slice(0, 40)` button list with a search box and
 * nothing else, and Settings' ModelPicker was a plain text input backed by a
 * native <datalist>. Neither showed price, context length or thinking
 * support next to a model id, neither remembered what you picked last time,
 * and neither let you narrow "every model this key can reach" down to
 * something scannable. This is the one place that reads the pricing
 * catalogue and lays a model list out; the two callers only supply their own
 * chrome (a chip button, a settings row) around it.
 * ========================================================================== */
import { useEffect, useMemo, useState } from "react";
import { catalogueEntry, loadPricing, priceForModel } from "@/services/pricing";
import { recentModels, recordModelUse } from "@/lib/recentModels";
import type { BackendType } from "@/types";

type Category = "recent" | "all" | "free" | "think" | "draw";

/** "anthropic/claude-sonnet-4" groups under "anthropic"; a bare id (Ollama,
 *  a custom server) groups under "local" rather than being left ungrouped.
 *  OpenRouter also lists "latest pointer" ids with a leading `~`
 *  (`~anthropic/claude-sonnet-latest`) — stripped so those land in the same
 *  group and avatar as the vendor's dated models instead of their own
 *  "~anthropic" bucket with a tilde for an initial. */
function providerOf(id: string): string {
  const i = id.indexOf("/");
  const raw = i > 0 ? id.slice(0, i) : "local";
  return raw.replace(/^~/, "");
}

function shortName(id: string): string {
  const i = id.indexOf("/");
  return i > 0 ? id.slice(i + 1) : id;
}

function fmtCtx(n?: number): string {
  if (!n) return "";
  return (n >= 1000 ? Math.round(n / 1000) + "k" : String(n)) + " ctx";
}

/** The bigger of the two per-million rates: output is what actually moves a
 *  bill, and a row has no room for two numbers nobody will stop to compare. */
function fmtPrice(backend: BackendType | "", id: string): string {
  const p = priceForModel(backend, id);
  if (!p) return "";
  if (p.prompt === 0 && p.completion === 0) return "free";
  return "$" + Math.max(p.prompt, p.completion).toFixed(2) + "/M";
}

function isFree(backend: BackendType | "", id: string): boolean {
  const p = priceForModel(backend, id);
  return !!p && p.prompt === 0 && p.completion === 0;
}

function canThink(id: string): boolean {
  return !!catalogueEntry(id)?.reasoning;
}

/**
 * Whether this model returns pictures.
 *
 * Read off `output_modalities`, which is the only place the catalogue says so
 * — `supported_parameters` does not list a single image control for any of
 * them, which is why lib/imageSpec.ts's dials report instead of being gated.
 *
 * Absent means no, not unknown, and that is the one place this file departs
 * from the three-state rule elsewhere. A model that cannot be shown to draw
 * must not be offered under a filter that promises drawing: the cost of
 * wrongly excluding one is that you type its name, and the cost of wrongly
 * including it is a thread that silently answers in words forever.
 */
export function canDraw(id: string): boolean {
  return !!catalogueEntry(id)?.outputModalities?.includes("image");
}

/** What it takes in beyond text, in one word — "image", "file", or both.
 *  null for text-only or for a model the catalogue has never heard of: an
 *  absent modality list is "not known", not "text-only", so it says nothing
 *  rather than asserting a capability gap that might not be real. */
function extraModality(id: string): string | null {
  const mods = catalogueEntry(id)?.inputModalities;
  if (!mods) return null;
  const extra = mods.filter((m) => m !== "text");
  if (!extra.length) return null;
  return extra.includes("image") && extra.includes("file") ? "image+file" : extra[0];
}

/** No accent hue is reserved for this, so one is picked deterministically
 *  from the small fixed palette tokens.css actually defines — same idea as a
 *  chat app's initial-letter avatar, just computed from the provider name
 *  instead of a person's, and expressed as a class (`data-hue`) rather than
 *  an inline colour per CONTRIBUTING's tokens-only rule. */
const HUES = 5;
function hueOf(provider: string): number {
  let h = 0;
  for (let i = 0; i < provider.length; i++) h = (h * 31 + provider.charCodeAt(i)) >>> 0;
  return h % HUES;
}

/** Full detail for the native tooltip — the compact row can only fit a
 *  glance, and hovering is how you get the actual numbers behind it. */
function rowTitle(backend: BackendType | "", id: string): string {
  const entry = catalogueEntry(id);
  const price = priceForModel(backend, id);
  const lines = [id];
  if (price) {
    lines.push(
      price.prompt === 0 && price.completion === 0
        ? "Free"
        : `Input $${price.prompt.toFixed(2)}/M · Output $${price.completion.toFixed(2)}/M`
    );
  }
  if (entry?.contextLength) lines.push(entry.contextLength.toLocaleString() + " token context");
  if (entry?.reasoning) lines.push("Can think before answering");
  const extra = extraModality(id);
  if (extra) lines.push("Accepts " + extra + " input, not just text");
  return lines.join("\n");
}

export interface ModelPickerPanelProps {
  /** Narrow the whole picker to one kind of model. The image composer passes
   *  `canDraw` so a text model cannot be chosen for a thread whose every
   *  message is a picture. */
  restrict?: (id: string) => boolean;
  /** Said above the list when `restrict` has excluded everything, so an empty
   *  picker explains itself rather than looking broken. */
  restrictNote?: string;
  /** Every id this backend's key can reach, unsorted — the picker does its
   *  own grouping and filtering rather than trusting caller order. */
  models: string[];
  loading: boolean;
  backend: BackendType | "";
  /** The id currently in force, for the "on" highlight. */
  value: string;
  onChoose: (id: string) => void;
  autoFocus?: boolean;
}

export default function ModelPickerPanel({
  models,
  loading,
  backend,
  value,
  onChoose,
  autoFocus,
  restrict,
  restrictNote
}: ModelPickerPanelProps) {
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState<Category>("all");
  const [, forceRepaint] = useState(0);

  /* Pricing is a lazily-fetched, module-wide cache (services/pricing.ts) —
     this is typically the first thing to actually render from it, so it
     kicks the fetch and repaints once. Every price/context/thinking lookup
     below stays a synchronous read against whatever has resolved so far. */
  useEffect(() => {
    loadPricing().then(() => forceRepaint((n) => n + 1));
  }, []);

  const recents = useMemo(() => {
    const have = new Set(models);
    return recentModels().filter((id) => have.has(id));
  }, [models]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    let base = cat === "recent" ? recents : models;
    if (cat === "free") base = base.filter((m) => isFree(backend, m));
    else if (cat === "think") base = base.filter((m) => canThink(m));
    else if (cat === "draw") base = base.filter((m) => canDraw(m));
    /* A caller that only wants one kind of model narrows everything, the
       category strip included — the image composer must not offer a text
       model under any tab. Applied after the category so "Recent" inside a
       restricted picker means "recent models that draw". */
    if (restrict) base = base.filter(restrict);
    return q ? base.filter((m) => m.toLowerCase().includes(q)) : base;
  }, [models, recents, cat, query, backend, restrict]);

  /* The catalogue is fetched lazily and can be empty on first paint or behind
     a backend that publishes none. Restricting against nothing would show an
     empty picker and read as "your key reaches no image models", so an empty
     restricted list falls back to everything with the reason written above
     it. Saying why beats showing a blank. */
  const restrictedEmpty = !!restrict && !rows.length && !query.trim() && models.length > 0;
  const shown = restrictedEmpty ? models : rows;

  /* Grouped by provider once there is enough on screen to make headers worth
     it — recency order matters more than alphabetising for "Recent", and a
     five-model Ollama list does not need sectioning at all. */
  const grouped = useMemo(() => {
    if (cat === "recent" || shown.length < 8) return null;
    const by = new Map<string, string[]>();
    for (const id of shown) {
      const p = providerOf(id);
      const list = by.get(p);
      if (list) list.push(id);
      else by.set(p, [id]);
    }
    return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [shown, cat]);

  function choose(id: string) {
    const v = id.trim();
    if (!v) return;
    recordModelUse(v);
    onChoose(v);
  }

  function row(m: string) {
    const provider = providerOf(m);
    const price = fmtPrice(backend, m);
    const ctx = fmtCtx(catalogueEntry(m)?.contextLength);
    const thinks = canThink(m);
    const extra = extraModality(m);
    return (
      <button key={m} className={"modelpop-row" + (m === value ? " on" : "")} onClick={() => choose(m)} title={rowTitle(backend, m)}>
        <span className="modelpop-avatar" data-hue={hueOf(provider)}>
          {provider.charAt(0).toUpperCase()}
        </span>
        <span className="modelpop-row-name">{shortName(m)}</span>
        <span className="modelpop-row-meta">
          {extra && <span className="modelpop-badge cap">{extra}</span>}
          {thinks && <span className="modelpop-badge think">thinks</span>}
          {ctx && <span>{ctx}</span>}
          {price && <span>{price}</span>}
        </span>
      </button>
    );
  }

  return (
    <>
      <input
        className="fi mono"
        autoFocus={autoFocus}
        placeholder={loading ? "loading the list…" : "search, or type any model id"}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          // Typing an id the list has never heard of is legitimate — a local
          // server's model names are not discoverable everywhere.
          if (e.key === "Enter" && query.trim()) choose(query.trim());
        }}
      />

      <div className="modelpop-cats">
        {/* Hidden when the picker is already narrowed to one kind: "Free" and
            "Thinks" inside an image-only list are filters on a list that has
            one property in common, and the strip would mostly return nothing. */}
        {!restrict && recents.length > 0 && (
          <button type="button" className={"modelpop-cat" + (cat === "recent" ? " on" : "")} onClick={() => setCat("recent")}>
            Recent
          </button>
        )}
        {!restrict && (
          <>
            <button type="button" className={"modelpop-cat" + (cat === "all" ? " on" : "")} onClick={() => setCat("all")}>
              All
            </button>
            <button type="button" className={"modelpop-cat" + (cat === "free" ? " on" : "")} onClick={() => setCat("free")}>
              Free
            </button>
            <button type="button" className={"modelpop-cat" + (cat === "think" ? " on" : "")} onClick={() => setCat("think")}>
              Thinks
            </button>
            {/* Findable from ordinary chat too. The Image switch lets any
                thread come back with a picture, and before this there was no
                way to discover which models could actually do it. */}
            <button type="button" className={"modelpop-cat" + (cat === "draw" ? " on" : "")} onClick={() => setCat("draw")}>
              Draws
            </button>
          </>
        )}
      </div>

      <div className="modelpop-list">
        {loading && <div className="modelpop-empty">fetching what your key can reach…</div>}
        {!loading && restrictedEmpty && restrictNote && <div className="modelpop-note">{restrictNote}</div>}
        {!loading && shown.length === 0 && (
          <div className="modelpop-empty">
            {cat === "recent"
              ? "Nothing recent yet."
              : models.length
                ? "Nothing matches — press enter to use the text above as a model id."
                : "No list available — type an id and press enter."}
          </div>
        )}
        {!loading && shown.length > 0 && !grouped && shown.map(row)}
        {!loading &&
          grouped &&
          grouped.map(([provider, ids]) => (
            <div className="modelpop-group" key={provider}>
              <div className="modelpop-group-h">{provider}</div>
              {ids.map(row)}
            </div>
          ))}
      </div>
    </>
  );
}
