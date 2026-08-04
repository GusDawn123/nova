# art/ — Nova brand source art

Original, full-resolution brand pieces. These are the SOURCES — the app never
bundles them directly; it ships processed derivatives (see
`apps/mobile/assets/mascot/` and `scripts/strip_mascot_bg.sh` /
`scripts/make_blink_patch.sh` for the pipeline).

- `nova-logo.png` — the original logo. Brand blue `#0002DA` was sampled from it;
  the entire duotone design system (`docs/superpowers/specs/2026-08-02-nova-ui-design.md`)
  derives from this image.
- `nova-eyes-open.png` — the mascot, eyes open. Source for the app's mascot
  frames and the blink eye-patch.
- `nova-working.png` — "Nova working" (headphones + HUD panels, 2026-08-03).
  Already in brand duotone. Candidate art for loading/processing moments and
  marketing.

New art lands here at full resolution first; derivatives get generated from it.
Everything visual must respect the duotone rule — one blue, one white.
