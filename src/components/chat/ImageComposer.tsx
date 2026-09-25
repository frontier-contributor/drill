/* ============================================================================
 * ImageComposer — the drawing surface, in place of the chat composer.
 *
 * This began as a strip of dials bolted onto the chat composer, and that was
 * wrong twice over. A row of controls above a box that still says "Ask
 * anything" is not a separate place to work, it is chat wearing a hat; and the
 * one decision that matters most for a picture — which model draws it — was
 * not on it at all, behind a picker listing six hundred models with no way to
 * tell which of them can return an image.
 *
 * So Image mode swaps the composer out rather than decorating it. Three things
 * follow, and each is the reason for a piece of this file:
 *
 *  - **The prompt is the work.** It gets the reading face and room to be a
 *    paragraph, because an image prompt is written, not typed as a command.
 *  - **The setting is shown, not described.** The plate on the left *is* the
 *    aspect ratio, at a size you can see, and it changes shape as you choose.
 *    A row of 16px rectangles labelled "3:2 · 2:3 · 4:3" is a form; a frame
 *    that becomes the shape of your picture is the setting itself.
 *  - **The model is restricted, not merely suggested.** The picker here lists
 *    only models that return images, so this mode cannot be pointed at one
 *    that will answer in words.
 *
 * Attachments stay, because these models take a reference picture and editing
 * one you already have is half of what image generation is for.
 * ========================================================================== */
import { useEffect, useRef, useState } from "react";
import * as pricing from "@/services/pricing";
import * as drawing from "@/services/drawing";
import { useStoreSync } from "@/hooks/useStoreSync";
import { money } from "@/lib/models";
import * as AI from "@/services/ai";
import * as U from "@/lib/util";
import Icon from "@/components/ui/Icon";
import ModelChip from "./ModelChip";
import ToolsMenu from "./ToolsMenu";
import AttachmentCard, { type PendingFile } from "./AttachmentCard";
import { ingest } from "@/services/files/ingest";
import * as filesDb from "@/services/files/db";
import { fileIdsOf } from "@/lib/files/parts";
import { availability } from "@/lib/chatActions";
import { useChat } from "@/context/ChatContext";
import { ASPECTS, DEFAULT_IMAGE_SPEC, SIZES, type AspectId, type ImageSpec, type SizeId } from "@/lib/imageSpec";
import type { Attachment } from "@/types/chat";

/** The plate is a fixed square of room; the frame inside takes the chosen
 *  ratio within it. Sizing the *plate* to the ratio would make an ultrawide
 *  selection five times the area of a tall one and shove the prompt sideways
 *  every time you changed your mind. */
const PLATE = 62;
/** The same idea at swatch scale, in the row of shapes. */
const CHIP = 15;

function fit(ratio: number | null, box: number): { width: number; height: number } {
  if (ratio == null) return { width: box, height: box };
  return ratio >= 1 ? { width: box, height: box / ratio } : { width: box * ratio, height: box };
}

export default function ImageComposer({
  disabled,
  busy,
  onSend,
  onStop,
  droppedNonce,
  takeDropped
}: {
  disabled?: boolean;
  busy?: boolean;
  onSend: (text: string, attachments: Attachment[]) => void;
  onStop: () => void;
  /** Files dropped anywhere on the chat column. Drained here as well as in the
   *  chat composer, or a picture dropped onto the drawing surface would land
   *  in a queue nothing reads and simply disappear. Taken from the queue
   *  rather than passed as a prop, for the reason the chat composer takes
   *  them: this component remounts when the first message creates a
   *  conversation, and a prop holding the files would attach them again. */
  droppedNonce?: number;
  takeDropped?: () => File[];
}) {
  const { conversation, update, draftImage, setDraftImage, draftModel, setDraftModel } = useChat();
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [pending, setPending] = useState<PendingFile[]>([]);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const ingestCtl = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      /* Cleared as well as aborted. A cleanup that cancels a handle without
         clearing it leaves StrictMode's second mount holding a controller that
         is already aborted, and every file read after it is dropped. */
      ingestCtl.current?.abort();
      ingestCtl.current = null;
    };
  }, []);

  useEffect(() => {
    if (!droppedNonce || !takeDropped) return;
    const files = takeDropped();
    if (files.length) addFiles(files);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [droppedNonce]);

  const spec: ImageSpec = (conversation ? conversation.image : draftImage) || DEFAULT_IMAGE_SPEC;

  /* Asked through the same call the send path filters on, never
     `backend.supports` directly — the two must not disagree, or this surface
     promises a picture the request will never ask for. */
  const resolved = AI.resolve({ backend: conversation?.backend, model: conversation?.model || draftModel });
  const can = availability("image", resolved.backend.supports, resolved.model);

  /* What this model takes, from OpenRouter's image listing. Only those dials
     are offered: a size switch on a model with no sizes is a dead dial, and a
     shape it does not take is a refused request. A model the listing does
     not know keeps every dial, and the receipt under the picture checks. */
  useStoreSync(pricing);
  useEffect(() => {
    void pricing.loadImageCaps();
  }, []);
  const caps = pricing.imageCaps(resolved.model);
  const shapes = ASPECTS.filter((a) => a.id === "auto" || !caps?.aspects || caps.aspects.includes(a.id));
  const sizes = caps && !caps.resolutions ? [] : SIZES.filter((z) => z.id === "auto" || !caps?.resolutions || caps.resolutions.includes(z.id));
  /* The setting in force for this model: one it does not take is not sent,
     so the plate and the readout do not claim it either. */
  const aspect = shapes.some((a) => a.id === spec.aspect) ? spec.aspect : "auto";
  const size = sizes.some((z) => z.id === spec.size) ? spec.size : "auto";
  const chosen = ASPECTS.find((a) => a.id === aspect) || ASPECTS[0];

  /* Build on the last picture — offered once there is one. */
  const last = conversation ? drawing.lastPicture(conversation, conversation.turns.length) : undefined;
  const takesRefs = !caps || !!caps.refs;
  const chain = drawing.chaining(spec);

  /* What a picture costs, from the model's endpoints, when OpenRouter says. */
  const [rate, setRate] = useState<string>("");
  useEffect(() => {
    let live = true;
    setRate("");
    if (!resolved.model) return;
    void pricing.loadImageRates(resolved.model).then((r) => {
      if (!live || !r?.length) return;
      const first = r[0];
      setRate(`${money(first.usd)} per ${first.unit}`);
    });
    return () => {
      live = false;
    };
  }, [resolved.model]);

  function set(next: Partial<ImageSpec>) {
    const merged = { ...spec, ...next };
    /* The conversation once one exists, the draft before then. update()
       returns early with no conversation, so a dial without a draft silently
       does nothing until a message has already been sent. */
    if (conversation) update({ image: merged });
    else setDraftImage(merged);
  }

  function addFiles(list: FileList | File[]) {
    const incoming = Array.from(list);
    if (!incoming.length) return;
    if (!ingestCtl.current) ingestCtl.current = new AbortController();
    const signal = ingestCtl.current.signal;
    for (const file of incoming) {
      const id = U.uid("p");
      setPending((p) => [...p, { id, name: file.name || "file", label: "Reading" }]);
      ingest(file, { signal })
        .then((a) => {
          if (signal.aborted) return;
          setPending((p) => p.filter((x) => x.id !== id));
          setAttachments((prev) => [...prev, a]);
        })
        .catch((e: unknown) => {
          if (signal.aborted) return;
          const why = (e as Error)?.message || "That file could not be read.";
          setPending((p) => p.map((x) => (x.id === id ? { ...x, error: why } : x)));
        });
    }
  }

  function removeAttachment(a: Attachment) {
    setAttachments((p) => p.filter((x) => x.id !== a.id));
    /* Nothing else will ever point at the bytes of an attachment that was
       never sent, so dropping it here drops them too. */
    const ids = fileIdsOf(a);
    if (ids.length) void filesDb.remove(ids);
  }

  function draw() {
    const body = text.trim();
    if (!body || busy || disabled) return;
    onSend(body, attachments);
    setText("");
    setAttachments([]);
  }

  return (
    <div className="imgc">
      <div className="imgc-inner">
        <div className="imgc-head">
          <Icon name="image" size={13} className="imgc-mark" />
          <span className="imgc-title">Draw</span>
          <span className="imgc-sub">
            {conversation ? "every message here returns a picture" : "opens a thread that draws"}
          </span>
          {/* The way out, and the reason it is in the head rather than the
              deck. Replacing the chat composer took the mode picker off the
              screen with it, so Image mode had no exit at all — you could get
              in and not back. The head is the row about the *thread* (its mode
              and its model); the deck below is about this one picture. */}
          <ToolsMenu />
          <ModelChip
            conversation={conversation}
            draftModel={draftModel}
            onDraftModel={setDraftModel}
            kind="image"
            heading="Model for drawing"
          />
        </div>

        {!can.can && (
          <p className="imgc-warn" role="status">
            {can.why}
          </p>
        )}

        <div className="imgc-body">
          {/* The setting, at a size you can read. It animates between shapes,
              which is the difference between a control that reports its state
              and one that demonstrates it. */}
          <div className="imgc-plate" style={{ width: PLATE, height: PLATE }} aria-hidden="true">
            <span className={"imgc-frame" + (chosen.ratio == null ? " auto" : "")} style={fit(chosen.ratio, PLATE)} />
          </div>

          <div className="imgc-promptwrap">
            <textarea
              className="imgc-prompt"
              rows={2}
              value={text}
              disabled={disabled}
              placeholder="Describe the picture — what is in it, and how it should look."
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  draw();
                }
              }}
            />
            {/* The chosen shape in words, under the prompt. The plate shows it
                and this names it — a frame alone cannot tell 3:2 from 4:3. */}
            <p className="imgc-readout">
              {chosen.ratio == null ? "Any shape the model prefers" : `${chosen.label} · ${chosen.id}`}
              {size !== "auto" && ` · ${size}`}
              {rate && ` · ${rate}`}
            </p>
          </div>
        </div>

        {(attachments.length > 0 || pending.length > 0) && (
          <div className="imgc-files">
            {attachments.map((a) => (
              <AttachmentCard key={a.id} a={a} onRemove={() => removeAttachment(a)} />
            ))}
            {pending.map((p) => (
              <AttachmentCard
                key={p.id}
                pending={p}
                onRemove={p.error ? () => setPending((x) => x.filter((y) => y.id !== p.id)) : undefined}
              />
            ))}
          </div>
        )}

        <div className="imgc-deck">
          <div className="imgc-group" role="radiogroup" aria-label="Shape">
            {shapes.map((a) => (
              <button
                key={a.id}
                type="button"
                className={"imgc-shape" + (a.id === aspect ? " on" : "")}
                role="radio"
                aria-checked={a.id === aspect}
                aria-label={a.ratio ? `${a.label}, ${a.id}` : "Auto"}
                title={a.ratio ? `${a.label} · ${a.id}` : "Auto — let the model choose"}
                onClick={() => set({ aspect: a.id as AspectId })}
              >
                <span
                  className={"imgc-swatch" + (a.ratio == null ? " auto" : "")}
                  style={a.ratio == null ? undefined : fit(a.ratio, CHIP)}
                  aria-hidden="true"
                />
              </button>
            ))}
          </div>

          {sizes.length > 1 && (
            <div className="imgc-seg" role="radiogroup" aria-label="Size">
              {sizes.map((z) => (
                <button
                  key={z.id}
                  type="button"
                  className={"imgc-segbtn" + (z.id === size ? " on" : "")}
                  role="radio"
                  aria-checked={z.id === size}
                  title={z.hint}
                  onClick={() => set({ size: z.id as SizeId })}
                >
                  {z.label}
                </button>
              ))}
            </div>
          )}

          {last && (
            <button
              type="button"
              className={"imgc-chain" + (chain && takesRefs ? " on" : "")}
              aria-pressed={chain && takesRefs}
              disabled={!takesRefs}
              title={
                !takesRefs
                  ? "This model draws from words alone — it takes no picture to work from"
                  : chain
                    ? "The last picture is sent with your prompt, so this edits it. Turn off to start fresh."
                    : "Each prompt starts a new picture. Turn on to edit the last one instead."
              }
              onClick={() => set({ chain: !chain })}
            >
              <Icon name="refresh" size={12} />
              <span>{chain && takesRefs ? "Editing the last picture" : "New picture"}</span>
            </button>
          )}

          <div className="imgc-spacer" />

          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              /* Cleared so picking the same file twice in a row still fires a
                 change event the second time. */
              e.target.value = "";
            }}
          />
          <button
            type="button"
            className="imgc-attach"
            disabled={disabled}
            title="Attach a reference picture to work from"
            aria-label="Attach a reference picture"
            onClick={() => fileRef.current?.click()}
          >
            <Icon name="paperclip" size={13} />
          </button>

          {busy ? (
            <button type="button" className="imgc-draw stop" onClick={onStop} title="Stop drawing">
              <Icon name="stop" size={12} />
              <span>Stop</span>
            </button>
          ) : (
            <button type="button" className="imgc-draw" onClick={draw} disabled={disabled || !text.trim()}>
              <Icon name="sparkle" size={12} />
              <span>Draw</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
