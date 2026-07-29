import { fireEvent, render, screen } from '@testing-library/react';
import { Pressable, Text, View } from 'react-native';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

/**
 * Harness smoke test (Phase 8.5, `docs/DESIGN/notes-ui.md` §9).
 *
 * `apps/mobile` had no test infrastructure at all, so this proves the three things
 * every later component suite depends on, and fails loudly if any of them regress:
 *
 *   1. `.tsx` compiles and React renders under the root vitest config
 *   2. `react-native` resolves to `react-native-web`, so RN primitives produce DOM
 *   3. the jest-dom matchers are registered by `setup.ts`
 *
 * It is deliberately about the HARNESS, not about product behaviour — when a later
 * component test fails, this one tells you instantly whether the plumbing broke or
 * the component did.
 */

function Counter(): React.JSX.Element {
  const [count, setCount] = useState(0);
  return (
    <View>
      <Text>{`count ${String(count)}`}</Text>
      <Pressable accessibilityRole="button" onPress={() => setCount(count + 1)}>
        <Text>bump</Text>
      </Pressable>
    </View>
  );
}

describe('mobile test harness', () => {
  it('renders react-native primitives to the DOM', () => {
    render(
      <View>
        <Text>hello from react-native-web</Text>
      </View>,
    );

    expect(screen.getByText('hello from react-native-web')).toBeInTheDocument();
  });

  it('runs hooks and re-renders on state change', () => {
    render(<Counter />);

    expect(screen.getByText('count 0')).toBeInTheDocument();
    // Press the element carrying the button role, not the inner Text: react-native-web
    // attaches Pressable's handlers to the outer node. And go through `fireEvent`
    // rather than a raw `.click()` so the update is wrapped in `act`.
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('count 1')).toBeInTheDocument();
  });

  it('resolves the @/ alias to apps/mobile/src', async () => {
    // The alias is declared globally in vitest.config.mjs; a broken path here is a
    // config error that would otherwise surface as a confusing import failure deep
    // inside a component suite.
    const mod = await import('@/features/notes/notes-update');
    expect(mod.emptyLiveNotes.rev).toBeNull();
  });
});
