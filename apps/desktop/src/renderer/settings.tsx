import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./design/fonts";
import { applyTheme } from "./design/theme";

import { SettingsApp } from "./settings/settings-app";
import "./design/kit/kit.css";
import "./settings.css";
import "./settings/panes.css";

applyTheme(document.documentElement);

const container = document.getElementById("root");
if (container === null) {
  throw new Error("renderer: #root is missing from settings.html");
}

createRoot(container).render(
  <StrictMode>
    <SettingsApp />
  </StrictMode>,
);
