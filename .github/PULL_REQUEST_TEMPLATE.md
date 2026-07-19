# What & why

<!-- One paragraph: what this PR does and why. Link the loop phase / parity rows. -->

## Checklist (GIT_WORKFLOW.md / RULES.md)

- [ ] Branched off `development`; PR targets `development` (or is a promotion/hotfix PR)
- [ ] Branch named `dev-<who>-<topic>`
- [ ] `development` merged INTO this branch and re-tested before requesting merge
- [ ] Tests written/updated and passing locally (`npm run check`)
- [ ] Migrations follow expand→backfill→contract; reverse documented
- [ ] Docs updated in this PR (ARCHITECTURE / ADR / PARITY / CLAUDE.md) or N/A because…
- [ ] No vendor SDK imported outside `adapters/`
- [ ] No secrets, no hard deletes, no reads from the reference repo
