/* ============================================================================
 * VideoComposer — the film surface, in place of the chat composer.
 *
 * Image mode's composer is the model for this, for the same reasons: the
 * prompt is the work and gets room to be a paragraph; the plate on the left
 * *is* the shape of the clip; the model picker lists only models that make
 * video. What video adds is the question a picture never raised this sharply
 * — *what will this cost* — because a clip is billed by the second and eight
 * seconds of 4K is dollars, not cents. So the price is on the composer, worked
 * out from the model's own SKUs before anything is asked for
 * (lib/mediaCaps.ts), and it moves as the dials do.
 *
 * Every dial is the model's: lengths, resolutions and shapes come from
 * OpenRouter's video listing, and a value the model does not take is never
 * shown and never sent (lib/videoSpec.ts). Sound appears only on models that
 * make it; "start from a picture" only on models that take one.
 * ========================================================================== */
import { useEffect, useRef, useState } from "react";
import * as AI from "@/services/ai";
import * as U from "@/lib/util";
import * as pricing from "@/services/pricing";
import { useStoreSync } from "@/hooks/useStoreSync";
import Icon from "@/components/ui/Icon";
import ModelChip from "./ModelChip";
import ToolsMenu from "./ToolsMenu";
import AttachmentCard, { type PendingFile } from "./AttachmentCard";
import { ingest } from "@/services/files/ingest";
import * as filesDb from "@/services/files/db";
import { fileIdsOf } from "@/lib/files/parts";
import { useChat } from "@/context/ChatContext";
import { aspectValue, videoEstimate } from "@/lib/mediaCaps";
import { effectiveVideo } from "@/lib/videoSpec";
import { money } from "@/lib/models";
import type { Attachment, VideoSpec } from "@/types/chat";

const PLATE = 62;
const CHIP = 15;

function fit(ratio: number | undefined, box: number): { width: number; height: number } {
  if (!ratio) return { width: box, height: box };
  return ratio >= 1 ? { width: box, height: box / ratio } : { width: box * ratio, height: box };
}

/** Lengths as buttons when there are a handful, as a menu when there are
 *  thirty — a row of thirty buttons is not a dial. */
const MAX_LENGTH_BUTTONS = 6;

export default function VideoComposer({
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
  droppedNonce?: number;
  takeDropped?: () => File[];
}) {
  const { conversation, update, draftVideo, setDraftVideo, draftModel, setDraftModel } = useChat();
  useStoreSync(pricing);
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [pending, setPending] = useState<PendingFile[]>([]);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const ingestCtl = useRef<AbortController | null>(null);

  useEffect(() => {
    void pricing.loadVideoCaps();
    return () => {
      /* Cleared as well as aborted, for StrictMode's second mount. */
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

  const resolved = AI.resolve({ backend: conversation?.backend, model: conversation?.model || draftModel });
  const model = resolved.model;
  const entry = pricing.catalogueEntry(model);
  const caps = pricing.videoCaps(model);
  const makesVideo = !!caps || !!entry?.kinds?.includes("video");
  const hasKey = !!AI.speechCreds("openrouter").apiKey;

  const spec: VideoSpec = (conversation ? conversation.video : draftVideo) || {};
  const eff = effectiveVideo(spec, caps);
  const canStart = !caps || !!caps.frames?.includes("first_frame");
  const picture = attachments.find((a) => a.kind === "image");
  const estimate = videoEstimate(caps, {
    seconds: eff.seconds || 0,
    resolution: eff.resolution,
    audio: eff.audio,
    fromImage: !!picture && canStart
  });

  const why = !hasKey
    ? "Making a video needs an OpenRouter key — add one under Settings → Connection."
    : !makesVideo
      ? `${entry?.title || model.split("/").pop() || "This model"} does not make video. Choose a video model to film with.`
      : caps?.needsVideo
        ? `${entry?.title || model} edits a video you give it, and there is no way to give it one here. Choose another model.`
        : "";

  /* Built on the latest value, not this render's: two dials changed before
     the re-render would otherwise each merge into the same stale spec, and
     the second would undo the first. The conversation is mutated in place by
     update(), so reading it at call time is reading the latest; the draft
     takes a functional update for the same reason. */
  function set(next: Partial<VideoSpec>) {
    if (conversation) update({ video: { ...(conversation.video || {}), ...next } });
    else setDraftVideo((prev) => ({ ...prev, ...next }));
  }

  function addFiles(list: FileList | File[]) {
    const incoming = Array.from(list).filter((f) => f.type.startsWith("image/")).slice(0, 1);
    if (!incoming.length) return;
    if (!ingestCtl.current) ingestCtl.current = new AbortController();
    const signal = ingestCtl.current.signal;
    for (const file of incoming) {
      const id = U.uid("p");
      setPending((p) => [...p, { id, name: file.name || "picture", label: "Reading" }]);
      ingest(file, { signal })
        .then((a) => {
          if (signal.aborted) return;
          setPending((p) => p.filter((x) => x.id !== id));
          /* One picture to start from; a second one replaces the first. */
          setAttachments((prev) => {
            for (const old of prev) {
              const ids = fileIdsOf(old);
              if (ids.length) void filesDb.remove(ids);
            }
            return [a];
          });
        })
        .catch((e: unknown) => {
          if (signal.aborted) return;
          const msg = (e as Error)?.message || "That picture could not be read.";
          setPending((p) => p.map((x) => (x.id === id ? { ...x, error: msg } : x)));
        });
    }
  }

  function removeAttachment(a: Attachment) {
    setAttachments((p) => p.filter((x) => x.id !== a.id));
    const ids = fileIdsOf(a);
    if (ids.length) void filesDb.remove(ids);
  }

  function film() {
    const body = text.trim();
    if (!body || busy || disabled || why) return;
    onSend(body, attachments);
    setText("");
    setAttachments([]);
  }

  const ratio = eff.aspect ? aspectValue(eff.aspect) : undefined;
  const lengths = caps?.durations || [];
  const readout = [
    eff.seconds ? `${eff.seconds} seconds` : "",
    eff.resolution || "",
    eff.aspect || "",
    eff.audio === true ? "with sound" : eff.audio === false ? "silent" : "",
    picture && canStart ? "from your picture" : ""
  ].filter(Boolean);

  return (
    <div className="imgc vidc">
      <div className="imgc-inner">
        <div className="imgc-head">
          <Icon name="film" size={13} className="imgc-mark" />
          <span className="imgc-title">Film</span>
          <span className="imgc-sub">{conversation ? "every message here makes a clip" : "opens a thread that films"}</span>
          <ToolsMenu />
          <ModelChip conversation={conversation} draftModel={draftModel} onDraftModel={setDraftModel} kind="video" heading="Model for video" />
        </div>

        {why && (
          <p className="imgc-warn" role="status">
            {why}
          </p>
        )}

        <div className="imgc-body">
          <div className="imgc-plate" style={{ width: PLATE, height: PLATE }} aria-hidden="true">
            <span className={"imgc-frame" + (ratio ? "" : " auto")} style={fit(ratio, PLATE)} />
          </div>
          <div className="imgc-promptwrap">
            <textarea
              className="imgc-prompt"
              rows={2}
              value={text}
              disabled={disabled}
              placeholder="Describe the clip — what happens, where the camera is, how it should feel."
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  film();
                }
              }}
            />
            <p className="imgc-readout">
              {readout.join(" · ") || "The model's own defaults"}
              {makesVideo && (
                <span className="vidc-cost" title={estimate.basis}>
                  {estimate.usd != null ? ` · about ${money(estimate.usd)}` : ` · ${estimate.basis}`}
                </span>
              )}
            </p>
          </div>
        </div>

        {(attachments.length > 0 || pending.length > 0) && (
          <div className="imgc-files">
            {attachments.map((a) => (
              <AttachmentCard key={a.id} a={a} onRemove={() => removeAttachment(a)} />
            ))}
            {pending.map((p) => (
              <AttachmentCard key={p.id} pending={p} onRemove={p.error ? () => setPending((x) => x.filter((y) => y.id !== p.id)) : undefined} />
            ))}
          </div>
        )}
        {picture && !canStart && (
          <p className="imgc-warn" role="status">
            This model starts from words only — the picture will not be sent.
          </p>
        )}

        <div className="imgc-deck">
          {lengths.length > 0 &&
            (lengths.length <= MAX_LENGTH_BUTTONS ? (
              <div className="imgc-seg" role="radiogroup" aria-label="Length">
                {lengths.map((d) => (
                  <button
                    key={d}
                    type="button"
                    className={"imgc-segbtn" + (d === eff.seconds ? " on" : "")}
                    role="radio"
                    aria-checked={d === eff.seconds}
                    onClick={() => set({ seconds: d })}
                  >
                    {d}s
                  </button>
                ))}
              </div>
            ) : (
              <label className="vidc-length">
                <span className="sr-only">Length</span>
                <select value={eff.seconds} onChange={(e) => set({ seconds: Number(e.target.value) })}>
                  {lengths.map((d) => (
                    <option key={d} value={d}>
                      {d} seconds
                    </option>
                  ))}
                </select>
              </label>
            ))}

          {(caps?.resolutions?.length || 0) > 1 && (
            <div className="imgc-seg" role="radiogroup" aria-label="Resolution">
              {caps!.resolutions!.map((r) => (
                <button
                  key={r}
                  type="button"
                  className={"imgc-segbtn" + (r === eff.resolution ? " on" : "")}
                  role="radio"
                  aria-checked={r === eff.resolution}
                  onClick={() => set({ resolution: r })}
                >
                  {r}
                </button>
              ))}
            </div>
          )}

          {(caps?.aspects?.length || 0) > 1 && (
            <div className="imgc-group" role="radiogroup" aria-label="Shape">
              {caps!.aspects!.map((a) => (
                <button
                  key={a}
                  type="button"
                  className={"imgc-shape" + (a === eff.aspect ? " on" : "")}
                  role="radio"
                  aria-checked={a === eff.aspect}
                  aria-label={a}
                  title={a}
                  onClick={() => set({ aspect: a })}
                >
                  <span className="imgc-swatch" style={fit(aspectValue(a), CHIP)} aria-hidden="true" />
                </button>
              ))}
            </div>
          )}

          {caps?.audio && (
            <button
              type="button"
              className={"imgc-chain" + (eff.audio !== false ? " on" : "")}
              aria-pressed={eff.audio !== false}
              title={eff.audio !== false ? "The model makes a soundtrack. Turn off for a silent clip — often cheaper." : "A silent clip. Turn on for a soundtrack."}
              onClick={() => set({ audio: eff.audio === false })}
            >
              <Icon name="speaker" size={12} />
              <span>{eff.audio !== false ? "Sound" : "Silent"}</span>
            </button>
          )}

          <div className="imgc-spacer" />

          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          {canStart && (
            <button
              type="button"
              className="imgc-attach"
              disabled={disabled}
              title="Start the clip from a picture"
              aria-label="Start from a picture"
              onClick={() => fileRef.current?.click()}
            >
              <Icon name="image" size={13} />
            </button>
          )}

          {busy ? (
            <button type="button" className="imgc-draw stop" onClick={onStop} title="Stop waiting for the clip">
              <Icon name="stop" size={12} />
              <span>Stop</span>
            </button>
          ) : (
            <button type="button" className="imgc-draw" onClick={film} disabled={disabled || !text.trim() || !!why}>
              <Icon name="film" size={12} />
              <span>Make video</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
