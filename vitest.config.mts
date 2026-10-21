import { configDefaults, defineConfig } from "vitest/config";

// Three suites:
// - unit: test/*.test.{js,ts}, no server, no database and no build. The .js
//   files are the old node:test files, which use `test` as a global.
// - build: test/build, which runs npm run build once (globalSetup) and checks
//   the pages it built and what Vercel would deploy.
// - integration: test/integration, a real server on a test database. The
//   setup file refuses any database whose name doesn't end in _e2e or _test.
//
// .claude/ holds worktrees with whole copies of the repo, so it is excluded
// everywhere; motion/ is its own Remotion project.
const exclude = [...configDefaults.exclude, ".claude/**", "motion/**"];

export default defineConfig({
  test: {
    globals: true,
    exclude,
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["test/*.test.{js,ts}"] },
      },
      {
        extends: true,
        test: {
          name: "build",
          include: ["test/build/**/*.test.ts"],
          globalSetup: ["test/build/setup.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          setupFiles: ["test/integration/setup.ts"],
          // One database shared by every file: run them one at a time.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
