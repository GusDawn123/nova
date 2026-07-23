import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

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
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
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
