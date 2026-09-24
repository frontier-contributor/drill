/* ============================================================================
 * VoiceOrb — the thing you look at while you talk.
 *
 * It is the whole of voice mode's feedback, so it has one rule: every motion
 * is a fact. It breathes while listening, swells with your voice while you
 * speak — the live microphone level — shimmers only while a request is open,
 * and moves with the reply's own loudness while it talks, read from the clip
 * at the audio element's playing position (services/voice/mouth.ts). An orb
 * that pulsed on a timer would be saying "working" when nothing was, which is
 * the one thing an interface you cannot see into must never do.
 *
 * Drawn on a canvas: three soft layers of a closed curve pushed in and out by
 * a sum of slow sines (no noise library, no WebGL), a glow behind them, and a
 * turning highlight for "thinking". Colours are the theme's own tokens,
 * painted through services/visuals/theme.ts because a canvas cannot read
 * oklch, and re-read when the printing changes.
 *
 * With reduced motion it stops moving and keeps meaning: a still disc with a
 * ring whose weight is the level — it still tells you it hears you.
 * ========================================================================== */
import { useEffect, useRef } from "react";
import { figureTheme } from "@/services/visuals/theme";
import { voice, type VoicePhase } from "@/services/voice";

interface Target {
  amp: number;
  scale: number;
  glow: number;
  spin: number;
  grey: number;
}

function target(phase: VoicePhase, muted: boolean, mic: number, out: number, t: number): Target {
  if (muted || phase === "off" || phase === "error") return { amp: 0.004, scale: 0.8, glow: 0.05, spin: 0, grey: 1 };
  switch (phase) {
    case "starting":
      return { amp: 0.02, scale: 0.84 + 0.02 * Math.sin(t * 5), glow: 0.2, spin: 0, grey: 0.4 };
    case "listening":
      return { amp: 0.03 + mic * 0.08, scale: 0.9 + 0.025 * Math.sin(t * 1.7) + mic * 0.06, glow: 0.3 + mic * 0.3, spin: 0, grey: 0 };
    case "hearing":
      return { amp: 0.05 + mic * 0.3, scale: 0.94 + mic * 0.17, glow: 0.45 + mic * 0.55, spin: 0, grey: 0 };
    case "thinking":
      return { amp: 0.028, scale: 0.88 + 0.012 * Math.sin(t * 3), glow: 0.42, spin: 1, grey: 0 };
    case "speaking":
      return { amp: 0.045 + out * 0.28, scale: 0.93 + out * 0.13, glow: 0.5 + out * 0.5, spin: 0, grey: 0 };
  }
}

function mix(a: string, b: string, k: number): string {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  const c = x.map((v, i) => Math.round(v + (y[i] - v) * k));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function rgba(hex: string, a: number): string {
  const n = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgba(${n[0]},${n[1]},${n[2]},${a})`;
}

export default function VoiceOrb({ size }: { size: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    const g = canvas?.getContext("2d");
    if (!canvas || !g) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);

    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    let theme = figureTheme();
    let printing = document.documentElement.dataset.theme;
    let raf = 0;
    let last = performance.now();
    let spinAngle = 0;
    const cur: Target = { amp: 0.02, scale: 0.84, glow: 0.2, spin: 0, grey: 0.4 };

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const t = now / 1000;

      if (document.documentElement.dataset.theme !== printing) {
        printing = document.documentElement.dataset.theme;
        theme = figureTheme();
      }

      const st = voice.get();
      const lv = voice.levels();
      const want = target(st.phase, st.muted, lv.mic, lv.voice, t);
      /* Eased toward the state, never jumped: a change of phase is a change of
         mood, and a snap reads as a glitch. Fast enough that a syllable still
         lands as one. */
      const k = 1 - Math.exp(-dt / 0.09);
      cur.amp += (want.amp - cur.amp) * k;
      cur.scale += (want.scale - cur.scale) * k;
      cur.glow += (want.glow - cur.glow) * k;
      cur.spin += (want.spin - cur.spin) * (1 - Math.exp(-dt / 0.35));
      cur.grey += (want.grey - cur.grey) * k;
      spinAngle += dt * 2.4 * cur.spin;

      const S = size * dpr;
      const c = S / 2;
      const R = S * 0.3 * cur.scale;
      const color = mix(theme.accent, theme.ink3, cur.grey);
      const hex = cur.grey > 0.5 ? theme.ink3 : theme.accent;
      g.clearRect(0, 0, S, S);

      /* The glow: how present the conversation is right now. */
      const glow = g.createRadialGradient(c, c, R * 0.4, c, c, R * 1.65);
      glow.addColorStop(0, rgba(hex, 0.32 * cur.glow));
      glow.addColorStop(1, rgba(hex, 0));
      g.fillStyle = glow;
      g.fillRect(0, 0, S, S);

      if (reduce) {
        g.beginPath();
        g.arc(c, c, R, 0, Math.PI * 2);
        g.fillStyle = color;
        g.fill();
        g.lineWidth = dpr * (1.5 + 6 * Math.max(lv.mic, lv.voice));
        g.strokeStyle = rgba(hex, 0.45);
        g.beginPath();
        g.arc(c, c, R * 1.18, 0, Math.PI * 2);
        g.stroke();
        return;
      }

      /* Three layers, back to front: wide and faint, then nearer, then the
         body. Each is the same curve with its own phase, so they drift
         against each other instead of moving as one rubber disc. */
      const layers = [
        { r: 1.16, a: 0.16, ph: 0.0, sp: 0.7 },
        { r: 1.07, a: 0.3, ph: 2.1, sp: 1.0 },
        { r: 1.0, a: 1, ph: 4.2, sp: 1.3 }
      ];
      const N = 96;
      for (const L of layers) {
        g.beginPath();
        const pts: [number, number][] = [];
        for (let i = 0; i < N; i++) {
          const a = (i / N) * Math.PI * 2;
          const w =
            0.55 * Math.sin(3 * a + t * 1.1 * L.sp + L.ph) +
            0.3 * Math.sin(5 * a - t * 0.8 * L.sp + L.ph * 2) +
            0.15 * Math.sin(8 * a + t * 1.9 * L.sp - L.ph);
          const r = R * L.r * (1 + cur.amp * w);
          pts.push([c + Math.cos(a) * r, c + Math.sin(a) * r]);
        }
        /* Through the midpoints, so the outline is smooth at any amplitude. */
        const mid = (p: [number, number], q: [number, number]) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2] as const;
        const m0 = mid(pts[N - 1], pts[0]);
        g.moveTo(m0[0], m0[1]);
        for (let i = 0; i < N; i++) {
          const p = pts[i];
          const m = mid(p, pts[(i + 1) % N]);
          g.quadraticCurveTo(p[0], p[1], m[0], m[1]);
        }
        g.closePath();
        if (L.a < 1) {
          g.fillStyle = rgba(hex, L.a);
          g.fill();
        } else {
          const body = g.createRadialGradient(c - R * 0.35, c - R * 0.4, R * 0.1, c, c, R * 1.1);
          body.addColorStop(0, mix(hex, "#ffffff", 0.35));
          body.addColorStop(0.55, color);
          body.addColorStop(1, mix(hex, "#000000", 0.25));
          g.fillStyle = body;
          g.fill();
          /* Thinking: a highlight turning round the body, only while a
             request is actually open. */
          if (cur.spin > 0.02 && "createConicGradient" in g) {
            const sheen = (g as CanvasRenderingContext2D & {
              createConicGradient(a: number, x: number, y: number): CanvasGradient;
            }).createConicGradient(spinAngle, c, c);
            sheen.addColorStop(0, `rgba(255,255,255,${0.32 * cur.spin})`);
            sheen.addColorStop(0.18, "rgba(255,255,255,0)");
            sheen.addColorStop(0.5, "rgba(255,255,255,0)");
            sheen.addColorStop(0.62, `rgba(255,255,255,${0.14 * cur.spin})`);
            sheen.addColorStop(0.8, "rgba(255,255,255,0)");
            sheen.addColorStop(1, `rgba(255,255,255,${0.32 * cur.spin})`);
            g.fillStyle = sheen;
            g.fill();
          }
        }
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [size]);

  /* Width and height are measured values — the canvas has to be told its
     size in CSS pixels to match the device pixels it is drawn at. */
  return <canvas ref={ref} className="vorb" style={{ width: size, height: size }} aria-hidden="true" />;
}
