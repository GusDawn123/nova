import type { MeetingListItem } from '@nova/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { cobaltPalette, paperPalette } from '@/design/tokens';
import { expectDuotoneOnly, normaliseColor } from '@/testing/duotone';
import { installLayoutStub } from '@/testing/layout-stub';

import { formatStartTime } from './format';
import { MeetingCard } from './meeting-card';

/**
 * One meeting card (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §5).
 *
 * The card is where the design's one hard rule about status lives. Before the
 * duotone there were four coloured pills; now there is exactly ONE chip — notes
 * ready — and everything else is said in words. Processing in particular must not
 * wear a chip at all: it gets the light sweep under the title and a mono whisper in
 * the meta row, because a chip that says "processing" is a badge for a state that is
 * about to stop existing.
 *
 * So these tests are mostly about what is ABSENT per status, which is the half a
 * redesign silently gets wrong.
 */
vi.mock('react-native-reanimated', async () => {
  const { reanimatedStub } = await import('@/testing/reanimated-stub');
  return reanimatedStub();
});

/**
 * Reduced motion is DRIVEN here, not left to the environment.
 *
 * jsdom has no `window.matchMedia`, and react-native-web's `AccessibilityInfo`
 * answers `isReduceMotionEnabled()` with TRUE when it cannot ask — so every sweep in
 * this suite would be correctly absent for a reason that has nothing to do with the
 * card. The real store also caches its answer for the life of the module (see
 * `design/motion.ts`), so flipping it any other way would leak between tests.
 */
const reduced = vi.hoisted(() => ({ value: false }));

vi.mock('@/design/motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/design/motion')>()),
  useReducedMotion: () => reduced.value,
}));

beforeEach(() => {
  reduced.value = false;
});

beforeAll(() => {
  // The chamfered chip and the sweep both draw from their measured box; jsdom
  // measures nothing without this, and they would pass by rendering empty.
  installLayoutStub();
});

const ID = '11111111-1111-4111-8111-111111111111';

function item(overrides: Partial<MeetingListItem> = {}): MeetingListItem {
  return {
    id: ID,
    title: 'Northwind discovery',
    started_at: '2026-07-22T12:40:00.000Z',
    ended_at: '2026-07-22T13:14:00.000Z',
    notes_status: 'completed',
    tldr: 'Three vendors, $40k left.',
    conversation_type: 'sales',
    action_item_count: 3,
    has_follow_up: true,
    ...overrides,
  };
}

function renderCard(
  overrides: Partial<MeetingListItem> = {},
  props: { today?: boolean; palette?: typeof cobaltPalette } = {},
): { onPress: ReturnType<typeof vi.fn>; container: HTMLElement } {
  const onPress = vi.fn<(id: string) => void>();
  const { container } = render(
    <MeetingCard
      meeting={item(overrides)}
      palette={props.palette ?? cobaltPalette}
      today={props.today ?? false}
      onPress={onPress}
    />,
  );
  return { onPress, container };
}

/** The meta row's own node — the one line every status branch writes into. */
function meta(): HTMLElement {
  return screen.getByTestId(`meeting-meta-${ID}`);
}

describe('MeetingCard — the line', () => {
  it('says when, how long, and what kind, in that order', () => {
    renderCard();

    // Time comes from the runner's own clock formatting, so it is asked for rather
    // than written out — the ORDER and the separators are what this pins.
    const time = formatStartTime('2026-07-22T12:40:00.000Z') ?? '';
    expect(meta()).toHaveTextContent(`${time} · 34 min · Sales`);
  });

  it('drops the parts a call does not have rather than printing lonely separators', () => {
    renderCard({ started_at: null, ended_at: null, conversation_type: null });

    expect(meta()).toHaveTextContent(/^$/);
  });

  it('shows the summary Nova already wrote, on one line', () => {
    renderCard();

    expect(screen.getByTestId(`meeting-preview-${ID}`)).toHaveTextContent(
      'Three vendors, $40k left.',
    );
  });

  it('opens the call it names', () => {
    const { onPress } = renderCard();

    fireEvent.click(screen.getByTestId(`meeting-card-${ID}`));

    expect(onPress).toHaveBeenCalledWith(ID);
  });
});

describe('MeetingCard — status without colour', () => {
  it('gives finished notes the one chip', async () => {
    renderCard({ notes_status: 'completed' });

    const chip = await screen.findByTestId(`meeting-chip-${ID}`);
    expect(chip).toHaveTextContent('NOTES READY');
    expect(screen.queryByTestId('light-sweep-band')).toBeNull();
  });

  it('sweeps for work in flight, and wears NO chip', async () => {
    renderCard({ notes_status: 'processing' });

    expect(await screen.findByTestId('light-sweep-band')).toBeInTheDocument();
    expect(meta()).toHaveTextContent('WRITING NOTES');
    // The old design badged this state. A chip is a label for something that is
    // going to be true for a while; this is going to stop being true.
    expect(screen.queryByTestId(`meeting-chip-${ID}`)).toBeNull();
    expect(screen.queryByText('NOTES READY')).toBeNull();
  });

  it('sweeps for a queued call too — it is the same wait', async () => {
    renderCard({ notes_status: 'queued' });

    expect(await screen.findByTestId('light-sweep-band')).toBeInTheDocument();
    expect(screen.queryByTestId(`meeting-chip-${ID}`)).toBeNull();
  });

  it('admits a failure in plain words, with nothing pretending to work', async () => {
    const { container } = renderCard({ notes_status: 'failed' });

    expect(meta()).toHaveTextContent('RETRY NOTES');
    expect(screen.queryByTestId(`meeting-chip-${ID}`)).toBeNull();
    expect(screen.queryByTestId('light-sweep-band')).toBeNull();
    // The failure is the classic place a third colour arrives (spec §11).
    await waitFor(() => {
      expect(container.querySelector('polygon')).toBeNull();
    });
    expectDuotoneOnly(container, cobaltPalette);
  });

  it('still SAYS it is working when motion is off', async () => {
    reduced.value = true;

    renderCard({ notes_status: 'processing' });

    // The sweep is decoration; the sentence is the signal. Someone who asked for no
    // motion must not lose the status along with the movement.
    expect(meta()).toHaveTextContent('WRITING NOTES');
    await waitFor(() => {
      expect(screen.queryByTestId('light-sweep-band')).toBeNull();
    });
  });

  it('says nothing at all about a call with no notes', () => {
    renderCard({ notes_status: 'none', tldr: null });

    expect(screen.queryByTestId(`meeting-status-${ID}`)).toBeNull();
    expect(screen.queryByTestId(`meeting-chip-${ID}`)).toBeNull();
    expect(screen.queryByTestId('light-sweep-band')).toBeNull();
  });
});

describe('MeetingCard — the surface', () => {
  it('washes today’s calls in ink and leaves the rest outlined', () => {
    renderCard({}, { today: true });

    const today = screen.getByTestId(`meeting-card-${ID}`);
    expect(normaliseColor(getComputedStyle(today).backgroundColor)).toBe(
      normaliseColor(cobaltPalette.inkFill),
    );
  });

  it('leaves an older call unfilled', () => {
    renderCard({}, { today: false });

    const older = screen.getByTestId(`meeting-card-${ID}`);
    const fill = normaliseColor(getComputedStyle(older).backgroundColor);
    expect(fill).not.toBe(normaliseColor(cobaltPalette.inkFill));
    expect(normaliseColor(getComputedStyle(older).borderTopColor)).toBe(
      normaliseColor(cobaltPalette.inkHairline),
    );
  });

  it('paints in ink and canvas only, in either theme', async () => {
    const { container } = renderCard(
      { notes_status: 'processing' },
      { today: true, palette: paperPalette },
    );

    await waitFor(() => {
      expect(container.querySelector('svg')).toBeTruthy();
    });
    expectDuotoneOnly(container, paperPalette);
  });
});
