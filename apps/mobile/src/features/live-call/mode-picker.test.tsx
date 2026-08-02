import { liveModeSchema } from '@nova/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ModePicker } from './mode-picker';

/**
 * The mode pills. Mode is per CALL — picked before starting, then locked — so the
 * two things worth pinning are that every wire mode is reachable and that the row
 * goes inert once a session is in flight.
 */

describe('ModePicker', () => {
  it('offers every wire mode, with the picked one marked', () => {
    render(<ModePicker mode="general" onSelect={() => undefined} disabled={false} />);

    for (const mode of liveModeSchema.options) {
      expect(screen.getByTestId(`mode-pill-${mode}`)).toBeInTheDocument();
    }
    // Live notes are a category, not a mode: they must never appear as a choice.
    expect(screen.queryByTestId('mode-pill-live-notes')).toBeNull();
    expect(screen.getByTestId('mode-pill-general')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByTestId('mode-pill-technical')).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('reports the pick to its owner (the hook holds the state)', () => {
    const onSelect = vi.fn();
    render(<ModePicker mode="general" onSelect={onSelect} disabled={false} />);

    fireEvent.click(screen.getByTestId('mode-pill-technical'));

    expect(onSelect).toHaveBeenCalledWith('technical');
  });

  it('is inert while a session is in flight', () => {
    const onSelect = vi.fn();
    render(<ModePicker mode="general" onSelect={onSelect} disabled />);

    fireEvent.click(screen.getByTestId('mode-pill-finance'));

    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByTestId('mode-pill-finance')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });
});
