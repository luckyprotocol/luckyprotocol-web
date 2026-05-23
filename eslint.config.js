// Flat ESLint config (ESLint v9+ format).
//
// Scope: this is a SAFETY-NET lint, not a style enforcer. The codebase
// is a single ~19k-line JSX file + a few protocol modules, so we don't
// try to be opinionated about formatting. We only fail the build on
// rules that catch real correctness bugs:
//
//   - react-hooks/rules-of-hooks  → conditional hooks crash at runtime
//   - react-hooks/exhaustive-deps → missing deps = stale closures
//   - no-undef                    → unreferenced globals = crashes
//   - no-unused-vars              → usually dead code or typos
//   - no-debugger / no-alert      → forgotten dev artifacts
//
// To run:  npm run lint
// To auto-fix what's fixable:  npm run lint:fix
//
// If you trip a warning you intentionally want to keep, prefix the
// offending line with `// eslint-disable-next-line <rule>` with a
// short justification on the same comment.

import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

export default [
  // Files we never touch — generated, vendored, or build output.
  // Note: the sibling directories (luckyprotocol-app/, luckyprotocol-indexer/,
  // luckyprotocol-web/) are .gitignored but ESLint walks the filesystem,
  // not the git index. Without explicit ignores it would try to lint the
  // minified production bundles inside their dist/ folders and explode
  // on "no-undef" for browser globals. Belt-and-braces: the lint script
  // in package.json also scopes to src/.
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "src/assets/inline/**", // base64 data modules
      "scripts/**",
      "*.config.js",
      // Local-only sibling dirs from the pre-flatten layout — not
      // tracked in git but still on the maintainer's filesystem.
      "luckyprotocol-app/**",
      "luckyprotocol-indexer/**",
      "luckyprotocol-web/**",
    ],
  },

  js.configs.recommended,

  {
    // Suppress the "unused eslint-disable directive" warnings. The
    // codebase has a handful of `// eslint-disable-next-line no-console`
    // comments that became "unused" when no-console was removed from
    // the rule set, but the comments document intent and we don't want
    // ESLint nagging about them.
    linterOptions: {
      reportUnusedDisableDirectives: "off",
    },
    files: ["src/**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
        ...globals.es2022,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      // ----- real-bug catchers (error) -----
      "react-hooks/rules-of-hooks": "error",
      "no-debugger": "error",
      "no-alert": "error",
      "no-undef": "error",
      "no-dupe-keys": "error",
      "no-dupe-args": "error",
      "no-unreachable": "error",
      "no-constant-condition": ["error", { checkLoops: false }],

      // ----- soft warnings (don't break CI but show up locally) -----
      "react-hooks/exhaustive-deps": "warn",
      "no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "prefer-const": "warn",

      // ----- React-specific guardrails -----
      "react-refresh/only-export-components": "off", // single-file app, doesn't apply
    },
  },
];
