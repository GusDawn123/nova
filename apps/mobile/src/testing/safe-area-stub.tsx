import { View, type ViewProps } from 'react-native';

/**
 * `react-native-safe-area-context`, for tests.
 *
 * The package publishes untranspiled source, so Node cannot even parse it under
 * vitest — importing anything that reaches it fails with a syntax error before a
 * single assertion runs. It is also a NATIVE module: the real insets come from the
 * platform, which jsdom does not have and never will.
 *
 * So the stub is the honest thing, not a shortcut: a plain view and a zero inset.
 * Any screen that hangs its layout on real insets is verified on the simulator.
 *
 * Use it the way the Reanimated stub is used — the factory has to be reached from
 * inside the (hoisted) mock:
 *
 * ```ts
 * vi.mock('react-native-safe-area-context', async () => {
 *   const { safeAreaStub } = await import('@/testing/safe-area-stub');
 *   return safeAreaStub();
 * });
 * ```
 */

const ZERO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 } as const;

export function safeAreaStub(): Record<string, unknown> {
  return {
    SafeAreaView: (props: ViewProps) => <View {...props} />,
    SafeAreaProvider: (props: ViewProps) => <View {...props} />,
    useSafeAreaInsets: () => ZERO_INSETS,
    useSafeAreaFrame: () => ({ x: 0, y: 0, width: 390, height: 844 }),
    initialWindowMetrics: { insets: ZERO_INSETS, frame: { x: 0, y: 0, width: 390, height: 844 } },
  };
}
