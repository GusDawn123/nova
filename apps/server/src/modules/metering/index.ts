/**
 * Public surface of the `metering` module (adr-0007): the port contracts + zod
 * schemas, the config + price book, and the service factory. No `process.env` read
 * and no vendor SDK crosses this boundary — env/pool wiring lives in app.ts (RULES
 * §2). The DB adapter that satisfies `UsageEventsDb` lives in
 * `apps/server/src/db/usage-events.ts` (house db-seam style).
 */

export {
  usageKindSchema,
  usageEventInputSchema,
  type UsageKind,
  type UsageEventInput,
  type UsageEventsDb,
  type MeteringLogger,
  type MeteringService,
} from "./ports.js";

export {
  meteringConfigSchema,
  meteringConfig,
  canUseLiveNotes,
  type MeteringConfig,
  type PlanId,
} from "./config.js";

export {
  priceBookSchema,
  createPricer,
  type PriceBook,
  type Pricer,
} from "./pricing.js";

export { createMeteringService, type MeteringServiceDeps } from "./service.js";

export {
  createQuotaChecker,
  type QuotaChecker,
  type QuotaCheckerDeps,
  type QuotaKind,
  type PlanReader,
} from "./quota.js";

export {
  createKillSwitch,
  type KillSwitch,
  type KillSwitchDeps,
} from "./kill-switch.js";

export {
  revenueCatEnvelopeSchema,
  createRevenueCatHandler,
  createRevenueCatRoutes,
  type RevenueCatEvent,
  type RevenueCatHandlerDeps,
  type RevenueCatRoutesDeps,
  type PlanWriter,
} from "./revenuecat.js";
