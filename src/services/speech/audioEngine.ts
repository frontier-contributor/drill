/* ============================================================================
 * audioEngine.ts — reading aloud with a hosted voice.
 *
 * Text goes to AI.speak() a clip at a time and comes back as compressed audio,
 * which plays through one <audio> element for the whole reading. Almost
 * everything here is about keeping that small in memory and honest about
 * money:
 *
 *   At most two clips are held: the one playing and the one fetched ahead.
 *   Anything else is aborted or dropped the moment playback moves past it.
 *
 *   Audio stays compressed. Decoding a clip into Web Audio samples would be
 *   about ten times the size and would buy nothing an <audio> element does
 *   not already give — including a speed change that keeps the voice's pitch.
 *
 *   One element, reused, and every object URL revoked as soon as its clip is
 *   done. Stopping removes the element's source and reloads it, which is what
 *   actually lets the browser free the decoder's buffers.
 *
 *   A clip heard before comes from the cache and costs nothing; a clip paid
 *   for is kept for next time, within the cap.
 *
 * Playback moves on the element's own events, never on timers, so a reading
 * carries on in a background tab, where timers can be throttled to once a
 * minute.
 * ========================================================================== */
import * as AI from "@/services/ai";
import { isAbort } from "@/services/ai/backends";
import * as cache from "./cache";
import type { Clip, EngineEvents, PlaybackEngine } from "./player";

export interface AudioEngineOptions {
  target: AI.SpeakTarget;
  label: string;
  title: string;
  cacheMB: number;
  /** What the operating system's media controls and the keyboard's media
   *  keys do while this voice is playing. */
  media: { play(): void; pause(): void; stop(): void; previous(): void; next(): void };
  /** Money actually spent, when it is spent. Replays from the cache never
   *  call this. */
  onSpend(chars: number, cost: number | undefined): void;
  /** A clip has just been put on the element. Voice mode reads the bytes once
   *  to draw the orb in time with the voice, and reads `currentTime` off the
   *  element to stay in step. It never routes the sound through Web Audio:
   *  Chrome's echo cancellation hears an <audio> element and would not hear
   *  that, and the microphone would pick the reply up as someone talking. */
  onAudio?(clip: Clip, blob: Blob, el: HTMLAudioElement): void;
}

interface Load {
  controller: AbortController;
  blob: Promise<Blob>;
}

/** A clip that is on the element and still silent after this long is not
 *  going to start: no sound device, or audio the browser accepted and then
 *  stalled on, which some browsers report as a stall rather than an error.
 *  Said plainly, instead of leaving "Preparing…" up for ever. */
const START_TIMEOUT_MS = 10_000;

const MEDIA_ACTIONS: MediaSessionAction[] = [
  "play",
  "pause",
  "stop",
  "previoustrack",
  "nexttrack",
  "seekbackward",
  "seekforward"
];

/**
 * A tenth of a second of silence, built here rather than embedded.
 *
 * It is played from inside the click that starts a reading. Safari only lets
 * a media element begin playing from within a user gesture, and the first
 * real clip arrives a second after the gesture has ended; an element that was
 * asked to play during the gesture is allowed to play again afterwards.
 */
function silence(): Blob {
  const samples = 800;
  const buf = new ArrayBuffer(44 + samples);
  const v = new DataView(buf);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + samples, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true);
  v.setUint32(28, 8000, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true);
  ascii(36, "data");
  v.setUint32(40, samples, true);
  new Uint8Array(buf, 44).fill(128);
  return new Blob([buf], { type: "audio/wav" });
}

function mediaError(e: MediaError | null): string {
  switch (e?.code) {
    case 2:
      return "The audio stopped arriving. Check the connection, then Retry.";
    case 3:
    case 4:
      return "This browser could not play the audio that voice returned. Try another voice.";
    default:
      return "The audio could not be played.";
  }
}

export function createAudioEngine(o: AudioEngineOptions): PlaybackEngine {
  const audio = new Audio();
  audio.preload = "auto";
  audio.preservesPitch = true;

  const loads = new Map<string, Load>();
  let ev: EngineEvents | null = null;
  /** Bumped by every play(). A callback holding an older value is stale. */
  let token = 0;
  /** The play() whose clip is on the element; 0 while none is. */
  let attached = 0;
  let playingText: string | null = null;
  let url: string | null = null;
  let seekTo = 0;
  let paused = false;
  let released = false;
  let rate = 1;
  let mediaSet = false;
  let watchdog: ReturnType<typeof setTimeout> | null = null;

  const live = () => !released && attached !== 0 && attached === token;

  function clearWatchdog() {
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
  }

  /** Armed each time play() is asked for, cleared the moment sound starts.
   *  A timer, but only ever as the fallback: playback itself still moves on
   *  the element's events, so throttled timers in a background tab can only
   *  make this report later, never make the reading stall. */
  function armWatchdog(my: number) {
    clearWatchdog();
    watchdog = setTimeout(() => {
      watchdog = null;
      if (released || paused || my !== token) return;
      if (!audio.paused && audio.currentTime > 0) return;
      ev?.failed(
        new Error("The audio arrived but would not start playing. Check this device's sound output, then Retry — or use this device's voice.")
      );
    }, START_TIMEOUT_MS);
  }

  audio.addEventListener("loadedmetadata", () => {
    if (!live()) return;
    if (seekTo > 0 && Number.isFinite(audio.duration)) audio.currentTime = seekTo * audio.duration;
    seekTo = 0;
  });
  audio.addEventListener("playing", () => {
    if (!live()) return;
    clearWatchdog();
    setPlaybackState("playing");
    ev?.started();
  });
  audio.addEventListener("timeupdate", () => {
    if (!live()) return;
    if (audio.duration > 0 && Number.isFinite(audio.duration)) ev?.progress(audio.currentTime / audio.duration);
  });
  audio.addEventListener("ended", () => {
    if (!live()) return;
    const done = ev;
    detach();
    done?.ended();
  });
  audio.addEventListener("error", () => {
    if (!live()) return;
    clearWatchdog();
    ev?.failed(new Error(mediaError(audio.error)));
  });

  let unlockUrl: string | null = URL.createObjectURL(silence());
  audio.src = unlockUrl;
  audio.play().then(
    () => {
      if (!attached) audio.pause();
    },
    () => undefined
  );

  /* ---------------------------------------------------------- media keys */

  function setPlaybackState(state: MediaSessionPlaybackState) {
    try {
      if (navigator.mediaSession) navigator.mediaSession.playbackState = state;
    } catch {
      /* not supported here */
    }
  }

  function setMedia() {
    if (mediaSet || typeof navigator === "undefined" || !navigator.mediaSession) return;
    mediaSet = true;
    const ms = navigator.mediaSession;
    try {
      if (typeof MediaMetadata !== "undefined") ms.metadata = new MediaMetadata({ title: o.title, artist: o.label, album: "Drill" });
    } catch {
      /* metadata is a nicety */
    }
    const handlers: Record<MediaSessionAction, (() => void) | undefined> = {
      play: o.media.play,
      pause: o.media.pause,
      stop: o.media.stop,
      previoustrack: o.media.previous,
      nexttrack: o.media.next,
      seekbackward: o.media.previous,
      seekforward: o.media.next
    } as Record<MediaSessionAction, (() => void) | undefined>;
    for (const action of MEDIA_ACTIONS) {
      try {
        ms.setActionHandler(action, handlers[action] || null);
      } catch {
        /* an action this browser does not know */
      }
    }
  }

  function clearMedia() {
    if (!mediaSet || typeof navigator === "undefined" || !navigator.mediaSession) return;
    const ms = navigator.mediaSession;
    for (const action of MEDIA_ACTIONS) {
      try {
        ms.setActionHandler(action, null);
      } catch {
        /* see above */
      }
    }
    try {
      ms.metadata = null;
      ms.playbackState = "none";
    } catch {
      /* see above */
    }
  }

  /* ------------------------------------------------------------ fetching */

  function load(clip: Clip): Load {
    const have = loads.get(clip.text);
    if (have) return have;
    const controller = new AbortController();
    const key = { engine: o.target.engine, model: o.target.model, voice: o.target.voice, text: clip.text };
    const blob = (async () => {
      const saved = await cache.getClip(key);
      if (saved) return new Blob([saved.audio], { type: saved.mime });
      if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
      const spoken = await AI.speak(clip.text, o.target, controller.signal);
      o.onSpend(spoken.chars, spoken.cost);
      void cache.putClip(key, spoken, o.cacheMB);
      return new Blob([spoken.audio], { type: spoken.mime });
    })();
    /* A clip fetched ahead and then skipped past rejects with nobody
       listening; that is expected, not an unhandled failure. */
    blob.catch(() => undefined);
    const entry = { controller, blob };
    loads.set(clip.text, entry);
    return entry;
  }

  /** Abort and forget every clip except these. */
  function keep(texts: (string | null)[]) {
    for (const [text, l] of loads) {
      if (texts.includes(text)) continue;
      l.controller.abort();
      loads.delete(text);
    }
  }

  /** Take the clip off the element: stop it, detach it, free its URL. */
  function detach() {
    clearWatchdog();
    attached = 0;
    playingText = null;
    try {
      audio.pause();
    } catch {
      /* already stopped */
    }
    if (audio.getAttribute("src")) {
      audio.removeAttribute("src");
      audio.load();
    }
    if (url) {
      URL.revokeObjectURL(url);
      url = null;
    }
    if (unlockUrl) {
      URL.revokeObjectURL(unlockUrl);
      unlockUrl = null;
    }
  }

  function rejected(my: number) {
    return (e: unknown) => {
      if (released || my !== token) return;
      const name = (e as { name?: string })?.name;
      /* Interrupted by a pause or by the next clip loading: not a failure. */
      if (name === "AbortError") return;
      clearWatchdog();
      ev?.failed(
        new Error(
          name === "NotAllowedError"
            ? "The browser blocked the audio until the page is clicked — press play again."
            : "The audio could not be played: " + ((e as Error)?.message || String(e))
        )
      );
    };
  }

  return {
    id: o.target.engine,
    label: o.label,
    maxChars: AI.BACKENDS[o.target.engine].speech?.maxChars ?? 800,

    play(clip, from, r, events) {
      if (released) return;
      const my = ++token;
      rate = r;
      paused = false;
      ev = events;
      keep([clip.text]);

      /* The clip already on the element — skipping back within it — is a
         seek, not another request. */
      if (playingText === clip.text && url) {
        attached = my;
        if (Number.isFinite(audio.duration)) audio.currentTime = from * audio.duration;
        audio.playbackRate = rate;
        void audio.play().catch(rejected(my));
        armWatchdog(my);
        return;
      }

      detach();
      playingText = clip.text;
      load(clip).blob.then(
        (blob) => {
          if (released || my !== token) return;
          url = URL.createObjectURL(blob);
          attached = my;
          seekTo = from;
          audio.src = url;
          o.onAudio?.(clip, blob, audio);
          /* A new source resets the playback rate to the default rate, so
             both are set, or every clip after the first would play at 1×. */
          audio.defaultPlaybackRate = rate;
          audio.playbackRate = rate;
          setMedia();
          if (!paused) {
            void audio.play().catch(rejected(my));
            armWatchdog(my);
          }
        },
        (err) => {
          if (released || my !== token || isAbort(err)) return;
          events.failed(err instanceof Error ? err : new Error(String(err)));
        }
      );
    },

    prepare(clip) {
      if (released) return;
      keep([playingText, clip.text]);
      load(clip);
    },

    pause() {
      paused = true;
      clearWatchdog();
      try {
        audio.pause();
      } catch {
        /* nothing playing */
      }
      setPlaybackState("paused");
    },

    resume() {
      if (released) return;
      paused = false;
      if (live()) {
        void audio.play().catch(rejected(token));
        armWatchdog(token);
      }
    },

    setRate(r) {
      rate = r;
      audio.defaultPlaybackRate = r;
      audio.playbackRate = r;
    },

    release() {
      released = true;
      token++;
      keep([]);
      detach();
      clearMedia();
      ev = null;
    }
  };
}
