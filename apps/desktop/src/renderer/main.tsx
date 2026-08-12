import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app";
import { applyTheme } from "./design/theme";
import "./index.css";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("renderer: #root is missing from index.html");
}

// Before the first paint: the stylesheet is written entirely in custom
// properties, so a document without them would flash unstyled.
applyTheme(document.documentElement);

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
