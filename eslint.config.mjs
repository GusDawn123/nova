import js from "@eslint/js";
import comments from "@eslint-community/eslint-plugin-eslint-comments/configs";
import vitest from "@vitest/eslint-plugin";
import prettier from "eslint-config-prettier";
import importPlugin from "eslint-plugin-import";
import globals from "globals";
import tseslint from "typescript-eslint";

// Vendor SDKs live ONLY inside `modules/*/adapters/` (RULES §hard prohibitions +
// ARCHITECTURE ports-and-adapters). Enforced below by no-restricted-imports so a
// stray `import OpenAI from "openai"` in a service fails the build instead of
// waiting for review to catch it.
const VENDOR_SDKS = [
  "openai",
  "@anthropic-ai/sdk",
  "@google/genai",
  "@google/generative-ai",
  "groq-sdk",
  "assemblyai",
  "@deepgram/sdk",
  "voyageai",
];

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/build/**",
      "**/node_modules/**",
      "**/.expo/**",
      // Expo template (apps/mobile) is linted by its own `expo lint`
      // (eslint-config-expo). The strict-type-checked root config below is tuned
      // for the TypeScript we author (server + shared); do not run it over the
      // generated React Native template rather than hand-editing every file.
      "apps/mobile/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  // Bare `// eslint-disable-next-line foo` is how a rule gets silently defeated.
  // `recommended` here turns on require-description (a disable must say WHY, the
  // same bar RULES §10 sets for every workaround) plus no-unused-disable, so a
  // disable left behind after the code changed fails the build instead of rotting.
  comments.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { import: importPlugin },
    rules: {
      // A stale disable directive is a lie about what the code needs. Error, not warn.
      "@eslint-community/eslint-comments/no-unused-disable": "error",
      "@eslint-community/eslint-comments/require-description": [
        "error",
        { ignore: [] },
      ],
      // ts-expect-error is allowed ONLY with a reason attached; ts-ignore never is
      // (it silently passes when the error goes away). ts-nocheck disables a whole file.
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-expect-error": "allow-with-description",
          "ts-ignore": true,
          "ts-nocheck": true,
          "ts-check": false,
          minimumDescriptionLength: 10,
        },
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: VENDOR_SDKS,
              message:
                "Vendor SDKs may only be imported inside modules/*/adapters/ (RULES: ports-and-adapters). Put the SDK behind the module's port.",
            },
            {
              // Three levels lands on a workspace root (adapters/ sit that deep);
              // four or more is a reach-around across module boundaries.
              group: ["../../../../*"],
              message:
                "Reach-around import (RULES §10). Move the shared code up, or import it through the owning module's public surface.",
            },
          ],
        },
      ],
      // RULES:163 claims imports are 'auto-sorted by the linter' — this is the rule
      // that makes that true. --fix sorts them.
      "import/order": [
        "error",
        {
          groups: [
            "builtin",
            "external",
            "internal",
            "parent",
            "sibling",
            "index",
          ],
          pathGroups: [{ pattern: "@nova/**", group: "internal" }],
          pathGroupsExcludedImportTypes: ["builtin"],
          // RULES specifies the ORDER, not the blank lines. Leaving grouping
          // whitespace alone keeps this rule from rewriting every file in the tree.
          "newlines-between": "ignore",
          alphabetize: { order: "asc", caseInsensitive: true },
        },
      ],
    },
  },
  // Adapters are the ONE place a vendor SDK is legal — lift the ban back off.
  {
    files: ["apps/server/src/modules/*/adapters/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../../../../*"],
              message:
                "Reach-around import (RULES §10). Move the shared code up, or import it through the owning module's public surface.",
            },
          ],
        },
      ],
    },
  },
  // Test files: the highest-value anti-cheat surface. A suite made green by
  // skipping the failing case, or narrowed to one passing case with .only, is a
  // false GREEN — and 'never claim done without the mechanical verification
  // passing' (CLAUDE.md) depends on the suite being whole.
  {
    files: ["**/*.test.ts", "**/*.test.tsx"],
    plugins: { vitest },
    rules: {
      "vitest/no-disabled-tests": "error",
      "vitest/no-focused-tests": ["error", { fixable: false }],
      // no-disabled-tests points at `.todo()` as the sanctioned alternative, but
      // `.todo` throws the assertion body away and the suite still reports green —
      // the exact shortcut this ruleset exists to stop. Runtime `describe.skipIf(!key)`
      // (the key-gated live smokes) is untouched: that is a real conditional, not a
      // disabled test.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "MemberExpression[object.name=/^(it|test|describe)$/][property.name='todo']",
          message:
            "`.todo()` discards the test body and still reports green. Implement it, or delete it and open an issue.",
        },
      ],
      // A test with zero assertions passes by doing nothing. `expect*` covers this
      // repo's shared-assertion helpers (e.g. expectSmokeShape) — the assertions
      // are real, they just live one call deep.
      "vitest/expect-expect": [
        "error",
        { assertFunctionNames: ["expect", "expect*"] },
      ],
      "vitest/no-identical-title": "error",
      "vitest/valid-expect": "error",
    },
  },
  // Plain-JS config files (e.g. eslint.config.mjs) and Node scripts (e.g.
  // scripts/gen-live-prompt.mjs) aren't part of any typecheck project — drop the
  // type-aware rules and give them the Node runtime globals (console, Buffer, …).
  {
    files: ["**/*.{js,cjs,mjs}"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: globals.node,
    },
  },
  prettier,
);
