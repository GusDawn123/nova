/**
 * The copilot modes, verbatim from the ratified mockup. One list feeds both
 * the pill's mode menu and the settings window's Modes tab, so the two
 * surfaces can never disagree about what exists.
 *
 * Purely presentational for now — picking a mode changes nothing upstream
 * until the live session is wired to the desktop client.
 */

export interface NovaMode {
  readonly id: string;
  readonly name: string;
  readonly desc: string;
}

export const NOVA_MODES: readonly NovaMode[] = [
  {
    id: "general",
    name: "General",
    desc: "The default mode. No custom prompt, summary template, or attached files. Nova uses its baseline behavior. Set this active to clear any mode you have selected.",
  },
  {
    id: "discovery",
    name: "Discovery Call",
    desc: "Nova asks the right qualifying questions, tracks pain points as they come up, and flags gaps in your qualification checklist so you leave discovery with a complete picture.",
  },
  {
    id: "demo",
    name: "Demo",
    desc: "Nova keeps your demo tied to the pain points from discovery, suggests which feature to show next, and catches buying signals the moment they surface.",
  },
  {
    id: "objection",
    name: "Objection Handling",
    desc: "Nova hears the objection, matches it to your playbook, and feeds you a response anchored in what the prospect already said on the call.",
  },
  {
    id: "negotiation",
    name: "Negotiation",
    desc: "Nova tracks every number mentioned, reminds you of your walk-away, and suggests trades instead of discounts when pricing pressure starts.",
  },
];
