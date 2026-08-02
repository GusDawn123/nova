/**
 * Image imports.
 *
 * Neither `expo/types` nor React Native declares these, so an image reached with an
 * ESM `import` has no type at all — which is why the generated template files still
 * use `require()`, whose declared return is `any`. An import is both typed and
 * portable, and portability is the part that matters: `require` is a Metro built-in,
 * so a component that used it could not be rendered by the vitest suites at all.
 *
 * The union is honest rather than convenient. Metro compiles an image import to an
 * asset-registry handle (a number); vite — which is what `apps/mobile`'s tests and the
 * Expo Web build run through — resolves it to a URL string. `expo-image` accepts
 * either, so the union is exactly what a caller may rely on.
 */
declare module '*.png' {
  const asset: number | string;
  export default asset;
}
