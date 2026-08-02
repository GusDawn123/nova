import AppTabs from '@/components/app-tabs';

/**
 * The tab navigator, one screen inside the `(app)` stack. The bar itself — a
 * floating canvas slab rather than a platform tab bar — lives in
 * `components/app-tabs.tsx`.
 *
 * The `(tabs)` group does not appear in URLs, so these routes keep the paths they
 * have always had: `/` for Meetings, `/live` for Live, and `/account` for Account,
 * which moved in here when it became a tab (so every existing `/account` link and
 * `router.push('/account')` still resolves).
 */
export default function TabsLayout(): React.JSX.Element {
  return <AppTabs />;
}
