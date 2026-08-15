import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// The design's two voices, bundled locally — a window that must never appear
// in a screen share must also never wait on (or leak requests to) a font CDN.
import "@fontsource/space-grotesk/400.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/600.css";
import "@fontsource/space-grotesk/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";

import { PillApp } from "./pill/pill-app";
import "./pill.css";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("renderer: #root is missing from pill.html");
}

createRoot(container).render(
  <StrictMode>
    <PillApp />
  </StrictMode>,
);
