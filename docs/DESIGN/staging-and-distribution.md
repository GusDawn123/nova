# Staging environment & distribution

Written 2026-08-03. Decisions ratified by Gustavo; the staging build-out itself
still gets a spec + plan before implementation.

## Ratified decisions

- **Staging = Railway + Supabase cloud + EAS sideload.** The Fastify server
  deploys to Railway (US East — the phone → Railway → STT-vendor relay sits
  inside the live latency budget; WebSocket support is non-negotiable since
  `/live` is the product). A Supabase **cloud** project replaces the local stack
  for staging; migrations apply via the linked-project push (same ledger
  mechanism `db:migrate` mirrors — prod never resets).
- **First device milestone:** EAS builds a signed **APK sideloaded on Gustavo's
  Android** — no store account needed — talking to staging end-to-end (typed
  steer first; mic capture is Phase 9).
- **Distribution order:** sideload → Play **internal testing** track → TestFlight
  (when the test iPhone joins).
- **Open question (recorded, not decided):** staging reuses the existing dev
  vendor keys (recommended while testers are just Gustavo + one) vs minting
  fresh per-vendor staging keys (the habit production will demand).

## Environment wiring

All variable names live in the root `.env.example` (names only, committed).
Real values are secrets and travel only by hand (password manager), never git.

- **Server (Railway env):** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  `SUPABASE_ANON_KEY`, `SUPABASE_DB_URL` (cloud project values), the vendor keys
  (`OPENAI_API_KEY`, `GOOGLE_API_KEY`, `ASSEMBLYAI_API_KEY`, `DEEPGRAM_API_KEY`,
  `VOYAGE_API_KEY`; `ANTHROPIC_API_KEY` stays disabled per the 2026-07-22 cost
  decision), `NOTES_WORKER_ENABLED=true`, and later `REVENUECAT_WEBHOOK_TOKEN`.
- **Mobile (EAS build-time env per profile):** `EXPO_PUBLIC_API_URL` (the
  Railway URL), `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`
  (cloud project's public pair). `eas.json` gets development / preview(staging)
  / production profiles.
- Production, later, is the same recipe repeated with its own Supabase project,
  its own Railway service, its own keys.

## Sideload → store: every variable, so nothing surprises

Runtime behavior of the app is IDENTICAL; every difference is packaging:

| Variable | Sideload | Play Store |
|---|---|---|
| Artifact | APK | AAB (one EAS config line) |
| Signing | upload key | **Play App Signing re-signs** → switching sideload→store requires one uninstall/reinstall (local data wiped once) |
| Policy | none | privacy policy URL, data-safety form, mic-permission justification; foreground-service `microphone` declaration once Phase 9 records screen-off |
| Updates | manual | store-managed (test this before external testers) |

Play caveat: NEW personal Play Console accounts must run a closed test (a
dozen-plus testers, 14 days) before **production** access — gates the public
launch, not internal testing or sideloading.

## Accounts checklist (all INDIVIDUAL — Nova is Gustavo's personal product; an
entity can take over later via app transfer, sensibly before charging money)

Only Gustavo can create these (identity + payment):

1. **Railway** (free to start; ~$5–20/mo running)
2. **Supabase** (cloud project; free tier fine for staging)
3. **Expo** (free; needed for EAS builds — free tier queues, ~$19/mo removes waits)
4. **Google Play Console** ($25 once; verification takes days — start early)
5. **Apple Developer** ($99/yr; only blocks the iPhone/TestFlight milestone; also
   unblocks the deferred Apple/Google sign-in from Phase 1)

## App identity (mandatory before any store upload)

`app.json` is still the Expo template: name "mobile", template icons/slug. Needs
a real bundle id / package name, her face as the icon (source in `art/`), the
brand-blue splash mark, mic permission strings, and a privacy policy URL. This
work is ledgered in the UI-redesign journal's next-branch list.

## STT testing reality (why staging precedes Phase 9)

The staging APK proves auth + `/live` socket + typed steer + notes end-to-end
from a real phone on a real network. Phase 9's capture spike then lands on a
proven pipe — see `docs/DESIGN/audio-capture.md` for the capture model, the
platform mechanics, and the supported call-on-speaker launch scenario.
