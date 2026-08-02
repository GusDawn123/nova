/**
 * Which answer a steer belongs to
 * (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §4, §10).
 *
 * The chip is the user's own words sitting above the answer they shaped. On the
 * MVP wire those two things travel SEPARATELY — the steer goes up as a
 * `transcript.input` and the answer comes back later as a `suggestion.start` that
 * carries no reference to it — so the pairing has to be made on this side, FIFO:
 * the next answer to start belongs to the oldest steer still waiting.
 *
 * That is an approximation, and here is exactly where it is wrong: if the conductor
 * emits an answer of its own between the steer going up and its answer coming back,
 * the chip lands on that one instead. The wire upgrade in spec §10 carries the steer
 * ON the trigger event and deletes this whole module; until then FIFO is the closest
 * true thing available, and it is confined here rather than smeared through the
 * screen.
 *
 * Pure and immutable, because the screen adjusts state off it DURING render: an
 * unchanged pairing must compare identical or that render loops forever.
 */

export interface SteerPairing {
  /**
   * Suggestion id → the steer that shaped it. A `Map` rather than a record so a
   * miss is `undefined` in the TYPE as well as at runtime — most answers are
   * unsteered, and that lookup is on the render path of every card.
   */
  readonly byId: ReadonlyMap<string, string>;
  /** Steers sent whose answer has not started yet, oldest first. */
  readonly pending: readonly string[];
  /** Every suggestion id already considered — what makes re-pairing impossible. */
  readonly known: ReadonlySet<string>;
}

export const emptySteerPairing: SteerPairing = {
  byId: new Map<string, string>(),
  pending: [],
  known: new Set<string>(),
};

/** Record a steer the user just sent. It waits here until an answer starts. */
export function steerSubmitted(
  pairing: SteerPairing,
  steer: string,
): SteerPairing {
  return { ...pairing, pending: [...pairing.pending, steer] };
}

/**
 * Hand the waiting steers to the answers that have appeared since the last call.
 *
 * Called on every render with the current suggestion ids, so it must be idempotent:
 * an id in `known` is never reconsidered, which is what stops a second pass over the
 * same list from eating the steer meant for the next card.
 */
export function pairSteerArrivals(
  pairing: SteerPairing,
  suggestionIds: readonly string[],
): SteerPairing {
  const arrived = suggestionIds.filter((id) => !pairing.known.has(id));
  if (arrived.length === 0) return pairing;

  const known = new Set(pairing.known);
  const byId = new Map(pairing.byId);
  const pending = [...pairing.pending];

  for (const id of arrived) {
    known.add(id);
    const steer = pending.shift();
    if (steer !== undefined) byId.set(id, steer);
  }

  return { byId, pending, known };
}
