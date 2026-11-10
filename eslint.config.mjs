import js from "@eslint/js";
import globals from "globals";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

const typedFiles = [
  "apps/{web,node-services,voice-runtime,computer,teamhub-cli}/**/*.{ts,tsx,mts,cts}",
  "packages/**/*.{ts,tsx,mts,cts}",
];

export default [
  {
    ignores: [
      "node_modules/**",
      "coverage/**",
      "dist/**",
      "**/dist/**",
      ".worktrees/**",
      ".linger-runtime/**",
      "playwright-report/**",
      "skills/builtin/*/*/**",
      "test-results/**",
      ".claude/**",
      ".cache/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
  },
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    rules: {
      "@typescript-eslint/consistent-type-definitions": ["error", "interface"],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: typedFiles,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      // react-router loaders throw `redirect()` / `Response` by design.
      "@typescript-eslint/only-throw-error": [
        "error",
        { allow: [{ from: "lib", name: "Response" }] },
      ],
      // Rejecting with `any`/`unknown` forwards caught errors and AbortSignal
      // reasons unchanged, matching only-throw-error's default behavior.
      "@typescript-eslint/prefer-promise-reject-errors": [
        "error",
        { allowThrowingAny: true, allowThrowingUnknown: true },
      ],
      "@typescript-eslint/no-base-to-string": "error",
      "@typescript-eslint/restrict-template-expressions": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/no-redundant-type-constituents": "error",
    },
  },
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
  {
    ...jsxA11y.flatConfigs.recommended,
    files: ["apps/web/src/**/*.{ts,tsx}"],
  },
  {
    files: ["**/*.mjs"],
    languageOptions: {
      globals: globals.node,
    },
  },
];
