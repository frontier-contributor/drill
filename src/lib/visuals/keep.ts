/* ============================================================================
 * keep.ts — a figure kept out of the conversation that drew it.
 *
 * artifacts.ts says a canvas is not stored anywhere: it is the fenced block in
 * the reply that wrote it, and every version of it is simply the blocks in
 * order. That is still true of a figure *in a thread*, and it is the reason
 * branching, export and backup carry canvases with no code of their own.
 *
 * It is not enough for a figure you want to come back to. A thread is a
 * conversation, not a shelf: the diagram that finally made backprop click is
 * four hundred messages back in a thread you named "q about grads", and the
 * only way to find it again is to remember which one. Keeping a figure writes
 * that one block down somewhere you can look.
 *
 * This file is the part with no browser in it: what identifies a kept figure,
 * and what happens when you keep the same one twice. Both have a failure mode
 * worth a test — the first duplicates your shelf, the second silently replaces
 * something you kept.
 *
 * Pure.
 * ========================================================================== */

import { canvasId, canvasTitle, parseFenceInfo } from "./artifacts";
import { visualDef, type VisualBlock, type VisualKind } from "./catalogue";

/**
 * What can sit on the shelf.
 *
 * Every `VisualKind` is something a model wrote as a fenced block, which is
 * why the catalogue teaches it and `Visual` draws it from its source. An
 * `image` is the one that is not: it is bytes a model handed back, so there is
 * nothing to teach and nothing to re-draw — which is exactly why it is a kind
 * here and not an entry in lib/visuals/catalogue.ts, whose whole promise is
 * that a kind added there is taught, drawn and described. The shelf has
 * tolerated a second sort of citizen since whiteboards landed on it.
 */
export type KeptKind = VisualKind | "image";

/** Where the bytes of a kept picture are, and what it takes to show one in a
 *  list without opening the file store. */
export interface KeptImage {
  fileId: string;
  mime: string;
  w: number;
  h: number;
  size: number;
  thumb?: string;
}

/** A block as `keep` takes it. Widened from `VisualBlock` only by the kind,
 *  because an image arrives through the same door. */
export interface KeptBlock {
  kind: KeptKind;
  info: string;
  /**
   * For a figure, the fenced block itself. **For an image, the file id** — the
   * thing that identifies it and the thing that fetches it back.
   *
   * That is not a shortcut. `figureKey` digests the source for every kind but
   * a canvas, and `holds` compares sources to decide whether a keep is a
   * repeat, so putting the file id here makes both of them exactly right for a
   * picture with no edits of the code below: two keeps of the same generated
   * image are one figure, two different pictures are two, and neither can be
   * a "revision" of the other, which for a photograph is the truth.
   */
  source: string;
}

/** A source this figure had before the one it has now. Oldest first, never
 *  dropped: locked decision 5, raw input is never destroyed. */
export interface KeptVersion {
  source: string;
  /** When it stopped being the current one. */
  at: number;
}

export interface KeptFigure {
  id: string;
  /** What makes two keeps the same figure. Computed once, when it is first
   *  kept, and deliberately *not* recomputed on rename — renaming a figure
   *  must not turn the next revision of it into a second figure. */
  key: string;
  kind: KeptKind;
  /** The fence's info string, which is where a canvas's title and id live.
   *  Empty for an image, which has no fence. */
  info: string;
  /** The fenced block — or, for an image, its file id. See `KeptBlock`. */
  source: string;
  /** Set only when `kind` is "image": where the bytes actually are. */
  image?: KeptImage;
  title: string;
  /** Why you kept it, in your own words. Empty until you write something. */
  note: string;
  projectId: string;
  /** The thread it came from, so it is one click back to what was being said
   *  around it. Absent for a figure kept from somewhere that is not a chat. */
  conversationId?: string;
  conversationTitle?: string;
  created: number;
  updated: number;
  versions: KeptVersion[];
}

/**
 * What this kind is called, and the fence it would be written in.
 *
 * One function rather than `visualDef(f.kind)` at four call sites, because
 * `image` is not in the figure catalogue and never will be — asking the
 * catalogue about it would be asking the list of things a model can *draw*
 * about a thing a model *returns*.
 */
export function keptLabel(kind: KeptKind): string {
  return kind === "image" ? "Image" : visualDef(kind).label;
}

/** The fence a kept figure is handed back to a model in. An image has none:
 *  it goes as itself, the way an attached picture does. */
export function keptFence(kind: KeptKind): string {
  return kind === "image" ? "" : visualDef(kind).fences[0];
}

/** What a figure is called when nobody has named it. The catalogue already
 *  knows how to say what each kind is — it says it to the card writer and to
 *  the voice — so this is that sentence with its brackets taken off rather
 *  than a second titling rule that could drift from the first. */
export function defaultTitle(block: Pick<KeptBlock, "kind" | "source" | "info">): string {
  /* A picture cannot be read for a title the way a spec or a fence can, so the
     caller passes one — what was asked for. This is only the fallback. */
  if (block.kind === "image") return "Image";
  if (block.kind === "canvas") return canvasTitle(block.info, block.source);
  const attrs = parseFenceInfo(block.info);
  if (attrs.title) return attrs.title;
  const def = visualDef(block.kind as VisualKind);
  const standIn = def.standIn(block.source, block.info);
  const inside = /^\[(.*)\]$/.exec(standIn.trim());
  const text = (inside ? inside[1] : standIn).replace(/^[a-z ]+:\s*/i, "").trim();
  return text || def.label;
}

/**
 * A 32-bit FNV-1a of the source, base36. Not a security hash — it is only
 * asking "is this the same block I already have", and an exact source match
 * is what identity means for every kind but a canvas.
 */
export function digest(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** Whether a canvas fence names itself, rather than falling back to "Canvas".
 *  A named canvas is a thing the model was told to call something; an unnamed
 *  one is anonymous, and every anonymous canvas has the same id. */
export function canvasNamed(info: string): boolean {
  const attrs = parseFenceInfo(info);
  return !!(attrs.id || attrs.title);
}

/**
 * What identifies this figure on the shelf.
 *
 * A canvas is keyed by its id, because that is exactly what a canvas already
 * means: the model rewrites one under the same title and the two blocks are
 * two versions of one thing (artifacts.ts). Keeping the revision therefore
 * updates what you kept rather than shelving a second copy, which is the whole
 * reason `versions` exists here.
 *
 * A *named* canvas is keyed across the project; an unnamed one only within its
 * thread. Both halves of that are load-bearing. Unnamed canvases all share the
 * fallback id, so a project-wide key would fold every anonymous canvas you
 * ever kept into one stack of versions. And a named one has to reach across
 * threads, because that is the loop this shelf exists for: attach the figure
 * you kept with `@`, ask for it to be changed, keep the reply — in a new
 * conversation, which under a thread-local key would have quietly started a
 * second figure with the same name instead of a second version of the first.
 *
 * Everything else is keyed by its source. A diagram's derived title is often
 * a single generic word — `mermaidTitle` returns "flowchart" for any flowchart
 * without a front-matter title — so keying those by title would have made the
 * second flowchart you kept look like a revision of the first and push it into
 * a version list you never asked for. Two charts are two charts unless they
 * are byte-for-byte the same block.
 */
export function figureKey(block: Pick<KeptBlock, "kind" | "source" | "info">, where: { projectId: string; conversationId?: string }): string {
  if (block.kind === "canvas") {
    const scope = canvasNamed(block.info) ? "named" : where.conversationId || "loose";
    return `${where.projectId}|${scope}|canvas|${canvasId(block.info)}`;
  }
  return `${where.projectId}|${block.kind}|${digest(block.source.trim())}`;
}

export interface KeepInput {
  block: Pick<KeptBlock, "kind" | "source" | "info">;
  /** The bytes, when the block is an image. */
  image?: KeptImage;
  projectId: string;
  conversationId?: string;
  conversationTitle?: string;
  /** Overrides the derived title. Nothing passes this yet; renaming happens
   *  on the record afterwards, which is what leaves `key` alone. */
  title?: string;
}

export type KeepStatus = "kept" | "revised" | "already";

/**
 * Fold a keep into whatever is already on the shelf under the same key.
 *
 * Three outcomes, and the middle one is the only interesting one:
 *
 *   already — this exact source is the current one, or is one of the versions
 *             already recorded. Nothing is written. Pressing Keep twice, or
 *             keeping a canvas you stepped back to, must not change anything.
 *   revised — a new source under a key that already exists. The source being
 *             replaced moves into `versions` first; nothing is overwritten.
 *   kept    — nothing was there.
 *
 * Returns a *new* record rather than mutating the old one, so a caller can
 * compare the two and the store can decide whether to write at all.
 */
export function foldKeep(
  existing: KeptFigure | undefined,
  input: KeepInput,
  now: number,
  newId: () => string
): { figure: KeptFigure; status: KeepStatus } {
  const source = input.block.source;
  const title = input.title || defaultTitle(input.block);

  if (!existing) {
    return {
      status: "kept",
      figure: {
        id: newId(),
        key: figureKey(input.block, input),
        kind: input.block.kind,
        info: input.block.info,
        source,
        image: input.image,
        title,
        note: "",
        projectId: input.projectId,
        conversationId: input.conversationId,
        conversationTitle: input.conversationTitle,
        created: now,
        updated: now,
        versions: []
      }
    };
  }

  if (holds(existing, source)) return { status: "already", figure: existing };

  return {
    status: "revised",
    figure: {
      ...existing,
      info: input.block.info,
      source,
      updated: now,
      /* The title the model gave the new version is ignored on purpose: the
         one on the shelf may be yours. */
      versions: [...existing.versions, { source: existing.source, at: existing.updated }]
    }
  };
}

/**
 * Whether this figure has ever held this source.
 *
 * Trimmed, because the two readers of a fence disagree about its last
 * newline: marked hands the block over without it and the scan over the
 * transcript keeps it, so an untrimmed comparison makes the figure you are
 * looking at look like one you have not kept.
 */
export function holds(f: KeptFigure, source: string): boolean {
  const t = source.trim();
  return f.source.trim() === t || f.versions.some((v) => v.source.trim() === t);
}

/** Every source this figure has had, oldest first, with the current one last —
 *  the order the version switcher counts in. Derived, so the record never
 *  holds the same source twice. */
export function allVersions(f: KeptFigure): KeptVersion[] {
  return [...f.versions, { source: f.source, at: f.updated }];
}
