import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// Bundled locally for the same reason the pill's are: no runtime font CDN.
import "@fontsource/space-grotesk/400.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";

import { App } from "./app";
import "./index.css";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("renderer: #root is missing from index.html");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
