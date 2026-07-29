import AppTabs from '@/components/app-tabs';

/**
 * The tab navigator, one screen inside the `(app)` stack (Phase 8.5,
 * `docs/DESIGN/notes-ui.md` §7.3). The bar itself — a floating glass pill rather
 * than a platform tab bar — lives in `components/app-tabs.tsx`.
 *
 * The `(tabs)` group does not appear in URLs, so these routes keep the paths they
 * had before the restructure: `/` for Meetings and `/live` for Live.
 */
export default function TabsLayout(): React.JSX.Element {
  return <AppTabs />;
}
