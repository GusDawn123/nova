import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./design/fonts";
import { applyTheme } from "./design/theme";

import { PillApp } from "./pill/pill-app";
import "./design/kit/kit.css";
import "./pill.css";

applyTheme(document.documentElement);

const container = document.getElementById("root");
if (container === null) {
  throw new Error("renderer: #root is missing from pill.html");
}

createRoot(container).render(
  <StrictMode>
    <PillApp />
  </StrictMode>,
);
