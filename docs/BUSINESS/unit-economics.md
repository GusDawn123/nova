# Nova unit economics

Written 2026-08-03 from first-principles modeling with Gustavo. Every dollar figure
below is an ESTIMATE derived from the price book
(`apps/server/src/modules/metering/pricing.ts`, rates verified 2026-07-23) — once
real users exist, re-derive everything from measured `usage_events` rows and
replace this page's constants.

**The design rule (Gustavo, binding): always price and cap for the worst case —
the maximal user — never the average.** The average user is the profit; the worst
case is the safety.

## Vocabulary

- **Gross** — the sticker price the customer pays ($60).
- **Net revenue** — gross minus the app-store commission. Apple/Google take 15%
  at small-business scale (<$1M/yr), so $60 gross → **$51 net**. The stores are
  also the payment processor and remit sales tax in most regions.
- **Profit per user** — net revenue minus that user's metered vendor cost.

## The cost constant

Fully-loaded worst case (everything lands on the pricier vendor, no prompt
caching):

| Component | Rate | Per streamed hour |
|---|---|---|
| STT (Deepgram, worst vendor) | $0.26/audio-hr | $0.26 |
| Live answers (~30 RESPONDs/hr, OpenAI lane) | ~3k in + ~150 out tokens each | ~$0.09 |
| Notes pipeline (per hour of transcript) | ~16k in / 2k out per 30 min | ~$0.04 |
| Embeddings/rerank | voyage-4 $0.06/1M | ~$0.001 |
| **Worst-case constant** | | **$0.40/hr** |

Realistic blended (AssemblyAI primary at $0.15/hr + Google's cheap lane):
**~$0.25/hr**. Cost-reduction levers, in order of impact: vendor order
(AssemblyAI primary), volume/enterprise STT deals at scale, prompt caching (the
`stablePrefix` prompt design exists for this).

## Plans (ratified 2026-08-02/03)

Weekly caps, Anthropic-style: hit the cap → wait for the weekly reset or
upgrade. Weekly beats monthly: smooths vendor spend and concurrency, and the
reset feels near.

Cap formula: **cap_hours = (net − target profit) ÷ $0.40**, target profit
$30–40/user (preferably $40) at FULL utilization.

| Plan | Gross | Net | Weekly cap | ~Monthly hrs | Worst-case cost | Profit floor |
|---|---|---|---|---|---|---|
| Trial | $0 | $0 | one 10-min session (+ response cap) | — | <$0.10 total | — |
| Premium | $60/mo | $51 | **7 hrs/week** | ~30 | ~$12 | **~$39** |
| Ultra | $120/mo | $102 | **35 hrs/week** | ~152 | ~$61 | **~$41** |

Floors are the MINIMUM profit (user drains every minute). Typical premium user
(~8 hrs/mo) costs ~$3 → ~$48 profit. Heavy users self-select up-tier via the
quota wall; there is deliberately no plan without a cap — an uncapped 24/7 user
would cost ~$292/mo, which is why "uncapped" must not be a reachable state.

## Weekly-reset engineering

The ledger design makes caps pure read-side policy — `usage_events` is
append-only and timestamped, so a cap check is "sum this user's `stt_seconds`
since the window started." No migration needed. Decisions:

- **Anchor**: per-user, from the subscription date (RevenueCat knows it) — fair,
  and no everyone-resets-at-once stampede. (Fixed Monday-UTC is the simpler
  fallback.)
- **No rollover** — unused hours die at reset; the floor math assumes it.
- **Mid-week upgrade is instant** — flipping `profiles.plan` re-evaluates the
  same usage against the bigger cap on the next check; RevenueCat prorates the
  money.
- **Enforcement points already exist** — session-start gate + mid-stream quota
  tick → typed `quota_exceeded` close; the mobile app renders that as
  wait-or-upgrade.
- **The meter must be visible** — remaining hours + reset day in Account, and an
  approaching-cap warning inside a live session. Silent walls make refunds;
  visible meters make upgrades.

## Past-Ultra: prepaid hour packs (there is no metered billing on mobile)

Neither Apple nor Google billing supports postpaid metering — you cannot bill
"what they used" after the fact through the store. The industry pattern, and
ours: **consumable in-app purchases of prepaid hours**.

- Product: past Ultra's cap, `quota_exceeded` offers a pack — ~**$15 for 10
  hours** (net ~$12.75, worst-case cost $4 → ~58% floor margin).
- Engineering: an append-only `credit_grants` table mirroring the ledger
  philosophy. The RevenueCat webhook (already token-gated and idempotent for
  plan changes) grants credits on purchase, keyed by store transaction id so a
  replayed webhook cannot double-grant. Balance = grants − consumption-past-cap,
  computed read-side at the same enforcement points. One table, one webhook
  case, one quota-check branch.
- Policy open: pack expiry (12 months is the clean answer) — Gustavo decides.
- Later, US-only margin optimization: web checkout via external purchase links
  (post-2025 ruling; commission rules still in flux). An optimization, not
  architecture — the pack design doesn't change.

## Concurrency: one vendor account is a capacity, not a lane

Nova holds ONE account per vendor (keys server-side only, per-user attribution
via the ledger — never per-user vendor keys). Vendor ceilings as of 2026-08
(re-check before scaling):

- **AssemblyAI**: no hard concurrent-stream cap; new-sessions/min limit
  auto-scales +10%/60s above 70% utilization; ~100 default.
- **Deepgram**: PAYG ~50 concurrent WSS streams (defaults recently tripled);
  bigger on Growth/Enterprise; per-project.
- **OpenAI**: spend-based tiers, auto-advancing (Tier 1 ~500 RPM → Tier 5
  10k RPM / 30M TPM).
- **Gemini**: spend-based tiers (Tier 1 ~150–300 RPM / 1M TPM → Tier 2+ higher).

The playbook: (1) admission control at Nova's door — count active streams per
vendor, route new sessions to the other vendor near a ceiling, refuse typed
("at capacity") only when both are full [the counter/budget is the one piece not
yet built]; (2) non-live work queues (the durable jobs queue absorbs spikes);
(3) dual-vendor spreading means ceilings add; (4) watch the ledger's concurrent
peak and request increases at ~60–70% utilization.

Sources consulted (2026-08-02): AssemblyAI concurrency docs, Deepgram rate-limit
docs + concurrency announcement, OpenAI/Gemini tier guides, RevenueCat
metered-usage discussion, external-purchase-link coverage (MacRumors/TechCrunch).
