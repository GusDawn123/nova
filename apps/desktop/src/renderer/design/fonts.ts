/**
 * The Nova typefaces, bundled locally — a window that must never appear in a
 * screen share must also never wait on (or leak requests to) a font CDN.
 *
 * The trio matches mobile's `design/fonts.ts` weight for weight: Orbitron for
 * display, Inter for body, Space Mono for numerals and machine-voice text
 * (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §2). The CSS custom
 * properties in `theme.ts` already name these families first, so importing the
 * faces here is the whole switch — no stylesheet learns a new name.
 */

import "@fontsource/orbitron/700.css";
import "@fontsource/orbitron/900.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/space-mono/400.css";
import "@fontsource/space-mono/700.css";
