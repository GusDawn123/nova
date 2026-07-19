# Nova — Feature Parity Checklist

> Living document (RULES.md §8). This is the answer to "did we miss anything the
> reference product has?" — every user-facing capability of the reference product
> (at the PUBLIC feature level: marketing pages, app-store listings, README feature
> lists — never its source), mapped to the Nova phase that delivers it and the
> verification that proves it. A phase is not DONE until its rows here are checked.
>
> Legend: ⬜ not started · 🔨 in progress · ✅ verified (link the test/loop evidence)

## Core capture & transcription

| # | Capability | Nova phase | Verified by | Status |
|---|---|---|---|---|
| 1 | Live transcription during a conversation (interim + final results) | 3 | fixture WAV streaming test | ⬜ |
| 2 | Speaker separation — who said what (diarization from single mic feed) | 3 | 2-speaker fixture, turn-boundary assert | ⬜ |
| 3 | Works for in-person conversations (mic acoustic capture) | 3 + 9 | noisy-fixture bar + physical-device E2E | ⬜ |
| 4 | Works for phone/VoIP calls via speakerphone | 9 | physical-device E2E checklist | ⬜ |
| 5 | STT provider failover (vendor outage invisible to user) | 3 | dead-endpoint failover test | ⬜ |
| 6 | Language selection for transcription | 3 (opt) | config test | ⬜ |

## Live copilot (during the call)

| # | Capability | Nova phase | Verified by | Status |
|---|---|---|---|---|
| 7 | Real-time suggestion cards (what to say / answer) | 7 | latency p50<2s + relevance ≥7/10 | ⬜ |
| 8 | Suggestions grounded in user's own context (RAG) | 7 | grounding test | ⬜ |
| 9 | Stays quiet during small talk (no spam) | 7 | quiet test (zero cards in no-op windows) | ⬜ |
| 10 | Rolling live transcript view in-app | 7 + 8 | live-call screen loop checklist | ⬜ |
| 11 | LLM provider fallback racing (slow/dead vendor invisible) | 2 | race/commit/breaker/classify test suite | ⬜ |
| 12 | Ask-AI free-form question mid-session | 7 (opt) | manual E2E step | ⬜ |

## Post-call notes (the hero)

| # | Capability | Nova phase | Verified by | Status |
|---|---|---|---|---|
| 13 | Auto-generated title | 5 | fixture fact-check | ⬜ |
| 14 | TL;DR + overview | 5 | schema + fixture tests | ⬜ |
| 15 | Decisions list | 5 | fixture fact-check | ⬜ |
| 16 | Action items with owner + deadline | 5 | "send proposal by Friday" assert | ⬜ |
| 17 | Open questions + risks | 5 | schema test | ⬜ |
| 18 | Conversation-type awareness (sales / interview / casual → different note shape) | 5 | 3-fixture differentiation test | ⬜ |
| 19 | Follow-up draft (email etc.), tone options, regenerate | 5 | draft-cites-notes-only test | ⬜ |
| 20 | Long-call handling (90-min transcript, no context overflow) | 5 | first+last-10-min facts assert | ⬜ |
| 21 | Crash recovery — interrupted processing resumes | 5 | kill-worker recovery test | ⬜ |
| 22 | Regenerate notes on demand | 5 | regenerate endpoint test | ⬜ |

## Memory & history

| # | Capability | Nova phase | Verified by | Status |
|---|---|---|---|---|
| 23 | Meeting history list + detail view (notes / transcript tabs) | 8 | screen loop checklists | ⬜ |
| 24 | Per-user context library ("your life": docs, profile, notes) | 4 | seed + top-3 retrieval test | ⬜ |
| 25 | Past calls auto-indexed into memory | 4 | freshness test (<60s) | ⬜ |
| 26 | Chat with a past meeting | post-MVP | — | ⬜ |
| 27 | Cross-meeting recall ("still open from last time") | post-MVP | — | ⬜ |
| 28 | Speaker rename/labeling on saved transcripts | post-MVP | — | ⬜ |

## Accounts, money, trust

| # | Capability | Nova phase | Verified by | Status |
|---|---|---|---|---|
| 29 | Sign up / in (email + Apple + Google), session persistence | 1 | auth flow tests | ⬜ |
| 30 | Per-user data isolation (A can never see B) | 1 | RLS A/B tests — CI-blocking | ⬜ |
| 31 | In-app account deletion (Apple mandate) | 1 | deletion test | ⬜ |
| 32 | Free tier limits + paid plans (quota enforcement) | 6 | quota + paywall tests | ⬜ |
| 33 | Usage metering accurate vs vendor-reported | 6 | ±5% metering test | ⬜ |
| 34 | Transcript-only storage (no audio persisted) | 3 | code-audit + storage assert in E2E | ⬜ |
| 35 | Global spend kill-switch | 6 | kill-switch test — TestFlight gate | ⬜ |

## Explicitly OUT of scope (decided, not forgotten)

- Desktop overlay / screen-share stealth — desktop-only concept, contrary to Nova's model
- Screenshot/vision "read my screen" answers — desktop feature; revisit post-MVP
- BYO API keys — Nova is company-keys + subscription by design
- Local/offline models on device — cloud-first; revisit if privacy tier demanded
- Voice output / TTS — Nova is a silent text copilot
- Auto-SENDING follow-up emails — we draft, user sends (trust + deliverability)
