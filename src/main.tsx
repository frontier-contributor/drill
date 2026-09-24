import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { RootGuard } from "./components/Rescue";
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
