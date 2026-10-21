import js from "@eslint/js";
import { createNodeResolver, importX } from "eslint-plugin-import-x";
import globals from "globals";
import tseslint from "typescript-eslint";

// The browser code is ES modules: apps/web/src for the pages, packages/core/src
// for what the server, the tests and the motion workspace load too.
const BROWSER_MODULES = ["apps/web/src/**/*.js", "packages/core/src/**/*.js"];
// The boot overlay is inlined into each page as a classic script, ahead of the
// modules, and it is the one global they read: window.KlndrBoot.
const BOOT = "apps/web/src/shared/boot.js";

// Which pages may import what. Each page is its own build, so an import across
// them would quietly copy one page's code into another: admin code into the
// app, or anything at all into the login page, which is served to everyone.
const boundary = (regex, message) => ({ regex, message });
const BOUNDARIES = {
  "apps/web/src/login/**/*.js": [
    boundary("^(?!\\./|\\.\\./shared/)", "The login page is public: it may import only its own files and src/shared."),
  ],
  "apps/web/src/app/**/*.js": [
    boundary("(^|/)(admin|login)/", "The app may import src/shared and @klndr/core, never another page."),
  ],
  "apps/web/src/admin/**/*.js": [
    boundary("(^|/)(app|login)/", "Admin may import src/shared and @klndr/core, never another page."),
  ],
  "apps/web/src/shared/**/*.js": [
    boundary("(^|/)(app|admin|login)/", "src/shared is loaded by every page, so it may not import any one of them."),
  ],
  "packages/core/src/**/*.js": [
    boundary("^[^.]", "@klndr/core has no dependencies: the server, the tests and the motion workspace load it as it is."),
  ],
};

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      // Worktrees hold whole copies of the repo.
      ".claude/**",
      // Its own Remotion project, with its own tsconfig.
      "motion/**",
      "desktop/**",
      "data/**",
      "test-results/**",
      "playwright-report/**",
      "**/dist/**",
      "build/**",
      ".vercel/**",
    ],
  },

  {
    files: ["**/*.js", "**/*.cjs", "**/*.mjs"],
    ...js.configs.recommended,
  },
  {
    files: ["**/*.js", "**/*.cjs", "**/*.mjs"],
    rules: {
      // Unused arguments document a callback's signature; unused catch
      // bindings are the house style for "this can fail, and that's fine";
      // `const { password_hash, ...rest }` is how a field is left out.
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none", ignoreRestSiblings: true }],
      // Newer recommended rules that only restate idioms the existing JS uses
      // on purpose (`let x = null; try { x = ... }`, a rethrow without
      // `cause`). They stay on for TypeScript.
      "no-useless-assignment": "off",
      "preserve-caught-error": "off",
    },
  },

  // Node: the server, scripts and the CommonJS tests.
  {
    files: ["apps/server/**/*.js", "scripts/**/*.js", "test/**/*.js", "test/**/*.cjs"],
    languageOptions: { sourceType: "commonjs", globals: { ...globals.node } },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: { sourceType: "module", globals: { ...globals.node } },
  },
  {
    files: ["test/**/*.test.js"],
    languageOptions: { globals: { ...globals.vitest } },
  },

  // The browser.
  {
    files: BROWSER_MODULES,
    ignores: [BOOT],
    plugins: { "import-x": importX },
    settings: { "import-x/resolver-next": [createNodeResolver()] },
    languageOptions: { sourceType: "module", globals: { ...globals.browser, KlndrBoot: "readonly" } },
    rules: {
      "import-x/no-unresolved": "error",
      "import-x/named": "error",
      // Evaluation order is import order, so a cycle makes it depend on which
      // file a page happens to reach first.
      "import-x/no-cycle": "error",
    },
  },
  ...Object.entries(BOUNDARIES).map(([files, patterns]) => ({
    files: [files],
    rules: { "no-restricted-imports": ["error", { patterns }] },
  })),
  // Inlined as a classic script, and required by its unit test.
  {
    files: [BOOT],
    languageOptions: { sourceType: "script", globals: { ...globals.browser, module: "readonly" } },
  },

  // TypeScript: tests, configs and (from here on) new code.
  {
    files: ["**/*.ts", "**/*.mts", "**/*.cts"],
    extends: [tseslint.configs.recommended],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  // Playwright compiles these to CommonJS, so require is how they reach the
  // shared CommonJS helpers and the server.
  {
    files: ["playwright.config.ts", "e2e/**/*.ts"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
);
