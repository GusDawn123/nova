import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./design/fonts";

import { App } from "./app";
import { applyTheme } from "./design/theme";
import "./design/kit/kit.css";
import "./index.css";

applyTheme(document.documentElement);

const container = document.getElementById("root");
if (container === null) {
  throw new Error("renderer: #root is missing from index.html");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
