/* ============================================================================
 * ImageBar — the picture's shape and size, beside the composer.
 *
 * Only in Image mode, and that is the point of the mode. These two dials are
 * wanted on every message when the thread is for drawing and on none of them
 * when it is for talking, so putting them behind the Tools menu would cost a
 * click per picture, and putting them on the bar permanently would put two
 * controls nobody is using in front of every conversation in the app.
 *
 * Aspect is drawn rather than written. A row of rectangles in the real ratios
 * is read in one glance, where "3:2 · 2:3 · 4:3 · 3:4" has to be parsed; the
 * words and the numbers are both still on the title for anyone who wants
 * them. Size stays as words because a tier has no shape to draw.
 * ========================================================================== */
import { useChat } from "@/context/ChatContext";
import * as AI from "@/services/ai";
import { availability } from "@/lib/chatActions";
import { ASPECTS, DEFAULT_IMAGE_SPEC, SIZES, type AspectId, type ImageSpec, type SizeId } from "@/lib/imageSpec";

/** The swatch: a box in the aspect it stands for, sized to fit a common
 *  bounding square so a wide one and a tall one read as the same "amount" of
 *  picture rather than the ultrawide dominating the row. */
function Swatch({ ratio }: { ratio: number | null }) {
  if (ratio == null) return <span className="ibar-auto" aria-hidden="true" />;
  const w = ratio >= 1 ? 16 : 16 * ratio;
  const h = ratio >= 1 ? 16 / ratio : 16;
  return <span className="ibar-swatch" style={{ width: w, height: h }} aria-hidden="true" />;
}

export default function ImageBar() {
  const { conversation, update, draftImage, setDraftImage, draftModel } = useChat();
  /* Reads from the conversation once one exists and from the draft before
     then — the pattern every control on this bar follows, because update()
     returns early with no conversation and a dial without a draft is a dial
     that does nothing until you have already sent a message. */
  const spec: ImageSpec = (conversation ? conversation.image : draftImage) || DEFAULT_IMAGE_SPEC;

  /* Asked through the same call the send path filters on, never
     `backend.supports` directly — the two must not disagree, or the bar
     promises a picture the request will not ask for. A mode whose whole point
     is drawing has to say so when the chosen model cannot draw; saying it
     here rather than disabling the dials is deliberate, because the fix is one
     click away on the model chip and greyed-out controls do not explain
     themselves. */
  const resolved = AI.resolve({ backend: conversation?.backend, model: conversation?.model || draftModel });
  const can = availability("image", resolved.backend.supports, resolved.model);

  function set(next: Partial<ImageSpec>) {
    const merged = { ...spec, ...next };
    if (conversation) update({ image: merged });
    else setDraftImage(merged);
  }

  return (
    <div className="ibar">
      {!can.can && (
        <p className="ibar-warn" role="status">
          {can.why}
        </p>
      )}
      <div className="ibar-group" role="radiogroup" aria-label="Picture shape">
        <span className="ibar-cap">Shape</span>
        {ASPECTS.map((a) => (
          <button
            key={a.id}
            className={"ibar-btn" + (a.id === spec.aspect ? " on" : "")}
            role="radio"
            aria-checked={a.id === spec.aspect}
            aria-label={a.label + (a.ratio ? " " + a.id : "")}
            title={a.ratio ? `${a.label} · ${a.id}` : "Auto — let the model choose"}
            onClick={() => set({ aspect: a.id as AspectId })}
          >
            <Swatch ratio={a.ratio} />
          </button>
        ))}
      </div>

      <div className="ibar-group" role="radiogroup" aria-label="Picture size">
        <span className="ibar-cap">Size</span>
        {SIZES.map((z) => (
          <button
            key={z.id}
            className={"ibar-btn wide" + (z.id === spec.size ? " on" : "")}
            role="radio"
            aria-checked={z.id === spec.size}
            title={z.hint}
            onClick={() => set({ size: z.id as SizeId })}
          >
            {z.label}
          </button>
        ))}
      </div>
    </div>
  );
}
