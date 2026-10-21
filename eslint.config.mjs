import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

// The browser code is still classic scripts sharing top-level names in the
// order each page loads them (protected/index.html, admin/index.html). These
// maps are that graph written down: a name used but listed nowhere is a typo
// or a missing <script>. They go away when the files become modules and
// import what they use.
const SHARED = [
  "KlndrTheme", "KlndrBoot", "API", "KlndrPalette",
  "KlndrAnnouncementRules", "KlndrMarkdown", "KlndrAnnouncementMedia", "KlndrAnnouncementReader",
  "KlndrMotionCore", "KlndrScenes", "KlndrMotionTimeline", "KlndrMotion",
];
const APP = [
  "CategoryPicker", "HistoryStack", "TaskModel", "PhysicsEngine", "TimelineCanvas", "TimelineDOM",
  "DragController", "TasksSidebar", "KlndrAnnouncements", "KlndrApp",
];
const ADMIN = ["KlndrCharts", "KlndrAdmin", "KlndrStudio"];

const readonly = (names) => Object.fromEntries(names.map((name) => [name, "readonly"]));

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
      "protected/vendor/**",
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
    files: ["server.js", "server/**/*.js", "scripts/**/*.js", "test/**/*.js", "test/**/*.cjs"],
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

  // The browser: classic scripts, one shared global scope per page.
  {
    files: ["public/js/**/*.js", "protected/js/**/*.js", "admin/**/*.js"],
    languageOptions: { sourceType: "script", globals: { ...globals.browser } },
    rules: {
      // A file's top-level names are its exports: every page shares them. Each
      // file says which they are in an `/* exported Name */` comment, so a
      // helper declared at the top level by accident is an error rather than
      // one more global, and the move to modules can turn each comment into
      // an export statement.
      "no-implicit-globals": ["error", { lexicalBindings: true }],
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none", ignoreRestSiblings: true }],
      // An exported name is also listed in the maps above, for the files that
      // use it.
      "no-redeclare": ["error", { builtinGlobals: false }],
    },
  },
  {
    files: ["protected/js/**/*.js"],
    languageOptions: { globals: { ...readonly(SHARED), ...readonly(APP) } },
  },
  {
    files: ["admin/**/*.js"],
    languageOptions: { globals: { ...readonly(SHARED), ...readonly(ADMIN) } },
  },
  // Loaded by the browser as a global and by Node through require: palette,
  // the announcement rules and markdown, the motion files, the boot overlay.
  {
    files: [
      "protected/js/palette.js",
      "protected/js/announcements/rules.js",
      "protected/js/announcements/markdown.js",
      "protected/js/motion/*.js",
      "public/js/boot.js",
    ],
    languageOptions: { globals: { module: "readonly", require: "readonly" } },
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
