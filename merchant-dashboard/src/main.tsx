import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Initialises i18next (and applies the saved language + direction) before render.
import "./i18n";
import App from "./App.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
