/* ============================================================================
 * library.ts — loading Excalidraw, once, with its fonts served from here.
 *
 * Two things have to be true before the library is imported, and both are
 * easier to guarantee in one small module than to remember at four call sites.
 *
 * `window.EXCALIDRAW_ASSET_PATH` is set first. Left unset the library fetches
 * its hand-drawn fonts from a CDN the moment a board opens — a request to a
 * third party from an app that otherwise talks only to the backend you pointed
 * it at, and one that fails outright offline. The files are served from this
 * origin by the `drill-excalidraw-fonts` plugin in vite.config.ts.
 *
 * And it is loaded on demand, never from a module the review loop can reach:
 * the library and its stylesheet are about half a megabyte, for a screen most
 * sessions never open.
 * ========================================================================== */

type ExcalidrawModule = typeof import("@excalidraw/excalidraw");

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

let loading: Promise<ExcalidrawModule> | null = null;

export function excalidraw(): Promise<ExcalidrawModule> {
  if (loading) return loading;
  /* BASE_URL, not a literal "/": the app is served from the root today, and a
     deploy under a subpath would otherwise ask the root for its fonts. */
  window.EXCALIDRAW_ASSET_PATH = `${import.meta.env.BASE_URL || "/"}excalidraw/`;
  loading = (async () => {
    await import("@excalidraw/excalidraw/index.css");
    return await import("@excalidraw/excalidraw");
  })();
  loading.catch(() => {
    loading = null;
  });
  return loading;
}
