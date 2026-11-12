import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { RootGuard } from "./components/Rescue";
/* The three faces, from the app's own origin. They were a stylesheet on
   Google's servers: a render-blocking request to a third party on every
   load, from an app that otherwise talks only to the backend you picked, and
   fallback fonts whenever there was no network. Variable files, one per face
   and style; the browser fetches only the script ranges a page uses. */
import "@fontsource-variable/source-serif-4/opsz.css";
import "@fontsource-variable/source-serif-4/opsz-italic.css";
import "@fontsource-variable/plus-jakarta-sans/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "./styles/style.css";

/* RootGuard is outside App, not inside it, so that a crash in any provider —
   not only in a view — still lands on a page with a backup button on it
   rather than on a white one. */
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RootGuard>
      <App />
    </RootGuard>
  </StrictMode>
);
