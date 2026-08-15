import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// Bundled locally for the same reason the pill's are: no runtime font CDN.
import "@fontsource/space-grotesk/400.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/600.css";
import "@fontsource/space-grotesk/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";

import { SettingsApp } from "./settings/settings-app";
import "./settings.css";
import "./settings/panes.css";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("renderer: #root is missing from settings.html");
}

createRoot(container).render(
  <StrictMode>
    <SettingsApp />
  </StrictMode>,
);
