# Nova — Git & Environments Workflow

> Living document (RULES.md §8). Repo: `GusDawn123/nova` (private).
> Two GitHub accounts are connected on this machine (`gustavo-tcig`, `GusDawn123`).
> Nova work uses **GusDawn123** — run `gh auth switch -u GusDawn123` before repo
> operations. The repo-local git identity is set to GusDawn123; never commit to Nova
> with the other identity.

## Branch model

```
dev-<who>-<topic>  ──PR──▶  development  ──promotion PR──▶  staging  ──promotion PR──▶  main
   (feature work)            (integration)                  (soak/QA)                 (production)
```

### The law of feature branches

1. **Always branch off `development`. Always PR back into `development`.**
   Feature branches NEVER target `staging` or `main` — those two only ever receive
   promotion PRs (whole-state merges from the branch below them).
2. **Branch naming: `dev-<who>-<topic>`.** Who = short handle of the author
   (`dev-gus-paywall-screen`, `dev-claude-rls-policies`, `dev-maria-stt-adapter`).
   Lowercase, hyphenated, topic verb-first where natural.
3. **Merge commits, never squash, never rebase-merge.** History preserves the true
   shape of the work.
4. **Branches are NOT deleted on merge.** They remain for archaeology.
5. **`main` = production** (tagged `v0.x.y`, App Store builds cut here only) ·
   **`staging` = release candidate** (TestFlight internal) ·
   **`development` = integration + default branch** (PRs default-target it).

### The update ritual (keeping a feature branch fresh)

Always this direction, never the reverse:

```
git checkout development && git pull        # 1. pull latest development
git checkout dev-<who>-<topic> && git pull  # 2. pull your feature branch
git merge development                       # 3. merge development INTO the feature
npm run check                               # 4. re-test — conflicts resolved ≠ code works
git push                                    # 5. push
# 6. open/update PR → development
```

**Never merge a feature branch into `development` locally** — `development` only moves
via PRs on GitHub. The feature absorbs `development`; `development` never absorbs a
feature outside a PR.

### Review policy

- **Gustavo (repo owner / main dev): self-merge allowed.** His PRs still must pass all
  CI checks — green CI is non-negotiable for everyone.
- **Every other human contributor: review required** (by Gustavo) before merge.
- **AI-session PRs (`dev-claude-*`): Gustavo is the reviewer** — he merges after
  reading the PR summary and checking CI. An AI session never merges its own PR into
  `development` without Gustavo's go-ahead.

### Hotfixes

`hotfix/<topic>` branches from `main`, PRs back to `main` AND `development`.
Documented per-incident in `docs/RUNBOOKS/`.

## Guards per branch

| Check | development | staging | main |
|---|---|---|---|
| PR required (no direct push) | ✅ | ✅ | ✅ |
| CI: typecheck + lint + tests | ✅ | ✅ | ✅ |
| CI: fresh-DB migration replay + drift check | ✅ | ✅ | ✅ |
| CI: RLS isolation tests (A/B users) | ✅ | ✅ | ✅ |
| Merge-commit strategy only (squash/rebase disabled) | ✅ | ✅ | ✅ |
| Human review | non-Gustavo PRs | promotion PR | promotion PR |
| Staging soak (deployed + smoke passed) | — | — | ✅ |
| Manual approval (GitHub Environment protection) | — | — | ✅ |

> Plan note: GitHub branch-protection rules on **private** repos require a paid plan.
> Until then, the guards live in (a) repo merge settings (squash/rebase disabled at the
> repo level — enforced), (b) CI results on every PR (visible red/green), and (c) this
> document as procedure. Revisit protection rules when the plan supports them or the
> repo gains a second contributor, whichever first.

## Environments & secrets

| | development | staging | production |
|---|---|---|---|
| Branch | `development` | `staging` | `main` |
| Supabase project | nova-dev | nova-staging | nova-prod |
| Server deploy | dev host / local | staging host | prod host |
| Mobile | Expo dev build | TestFlight internal | App Store |
| Secrets | local `.env` + GH env `development` | GH env `staging` | GH env `production` (required reviewer) |

- Each environment has **its own Supabase project and its own vendor API keys**
  (a runaway staging test can never burn prod quota; keys revocable per-env).
- Migrations flow with the code: each env's deploy job applies pending migrations to
  that env's database — never by hand against prod (break-glass runbook excepted).

## Workflows (`.github/workflows/`)

- **`ci.yml`** — every PR: install → typecheck → lint → unit/integration tests →
  `supabase start` shadow DB → replay all migrations → drift check → RLS tests.
  *(Lands in Phase 0 with the first code; a placeholder passes until then.)*
- **`deploy-staging.yml`** — on merge to `staging`: migrate nova-staging → deploy
  server → EAS build (TestFlight internal) → post-deploy smoke.
- **`deploy-prod.yml`** — on merge to `main` (after environment approval): same chain
  against prod + tag release.

## PR template checklist

```
- [ ] Branched off development; PR targets development (or is a promotion/hotfix PR)
- [ ] Branch named dev-<who>-<topic>
- [ ] development merged INTO this branch and re-tested before requesting merge
- [ ] Tests written/updated and passing locally (npm run check)
- [ ] Migrations follow expand→backfill→contract; reverse documented
- [ ] Docs updated in this PR (ARCHITECTURE / ADR / PARITY / CLAUDE.md) or N/A because…
- [ ] No vendor SDK imported outside adapters/
- [ ] No secrets, no hard deletes, no reads from the reference repo
```
