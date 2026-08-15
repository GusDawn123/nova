/**
 * Static-asset module declarations for the renderer. Vite turns an imported
 * `.png` into its bundled URL (a string); TypeScript has no idea until told.
 * Only the formats the app actually ships are declared — a new format joining
 * the bundle should be a decision, not a wildcard.
 */
declare module "*.png" {
  const url: string;
  export default url;
}
