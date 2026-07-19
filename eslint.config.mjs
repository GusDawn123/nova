import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/build/**",
      "**/node_modules/**",
      "**/.expo/**",
      "**/expo-env.d.ts",
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
  // Expo template (apps/mobile): the generated React Native code is not authored
  // by us and does not meet strict-type-checked. Keep linting on, but drop the
  // type-aware rules for this workspace rather than hand-editing generated files.
  // server/shared keep full strict-type-checked.
  {
    files: ["apps/mobile/**/*.{ts,tsx,js,jsx}"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  // Config/plain-JS files (eslint.config.mjs, metro/babel configs) are not part of
  // any typecheck project — drop the type-aware rules for them.
  {
    files: ["**/*.{js,cjs,mjs}"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
);
