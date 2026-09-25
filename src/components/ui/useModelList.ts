/* ============================================================================
 * useModelList — what a backend says it serves, fetched once a session.
 *
 * The chip, Settings' model rows and regenerate-with each fetched the list the
 * first time they opened and threw it away when they unmounted, so every
 * thread switch paid for it again, and three open pickers were three calls.
 * One promise per backend for the session now: the list changes when a model
 * is released, not between two clicks, and the refresh button in the picker
 * (which refetches the catalogue) is there for when it does.
 *
 * Only fetched once something opens — `active` — because most messages are
 * sent without touching a picker, and this is a call against the learner's key.
 * ========================================================================== */
import { useEffect, useState } from "react";
import * as AI from "@/services/ai";
import type { BackendType } from "@/types";

const lists = new Map<string, Promise<string[]>>();

function fetchList(backend: BackendType | ""): Promise<string[]> {
  const key = backend || "(default)";
  const hit = lists.get(key);
  if (hit) return hit;
  const p = AI.listModels(backend ? { backend } : undefined).catch((e: unknown) => {
    /* A failure is not cached: the next open asks again. */
    lists.delete(key);
    throw e;
  });
  lists.set(key, p);
  return p;
}

export function useModelList(
  backend: BackendType | "",
  active: boolean
): { models: string[]; loading: boolean; error: string | null } {
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    let live = true;
    setLoading(true);
    setError(null);
    fetchList(backend)
      .then((m) => live && setModels(m))
      .catch((e: Error) => live && setError(e?.message || "The model list could not be loaded."))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [backend, active]);

  return { models, loading, error };
}
