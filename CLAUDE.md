# klndr — notes for agents

A fluid time-blocking planner: Express + MongoDB, a browser client of classic
scripts, deployed on Vercel. [README.md](README.md) is the architecture
reference (file map, data model, API, design decisions) — read the part you are
touching before changing it.

The codebase is partway through a planned migration to TypeScript, Vite,
Hono + Zod and React (for app chrome and admin only; the timeline engine stays
framework-free). Until a file has moved, keep it in its current style: don't
add new browser globals, and write new tooling and tests in TypeScript. Every
browser script is strict, and its top-level names are its exports: each is
declared in an `/* exported Name */` comment in the file and listed in the
globals maps in `eslint.config.mjs`, and lint rejects any other.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Server with `node --watch` on `PORT` (3001 in `.env`) |
| `npm run check` | Lint, typecheck, design-token lint and unit tests: run before every commit |
| `npm test` | Unit tests (Vitest, `test/*.test.js`): no server, no database |
| `npm run test:integration` | The HTTP API end to end against a test database (`test/integration`) |
| `npm run test:e2e` | Playwright UI tests (`e2e/`), desktop and phone projects |
| `npm run lint` / `npm run typecheck` | ESLint / `tsc` on the TypeScript so far |
| `npm run check:tokens` | Stylesheet design-token lint |
| `npm run build` | The Vercel deployment in `.vercel/output` (Build Output API); `npm run test:build` checks its layout |
| `npm run serve:bundle` | Serves `.vercel/output` locally the way Vercel does; `KLNDR_TARGET=bundle` points both suites at it |

The integration and UI suites create and delete accounts, so they refuse any
database whose name doesn't end in `_e2e` or `_test`
(`test/support/test-db.cjs`). Locally, `cp .env.test.example .env.test` sets
`MONGODB_DB=klndr_e2e`; the connection string comes from `.env`. CI runs both
against a throwaway Mongo container. Playwright needs
`npx playwright install chromium` once.

`motion/` is a separate Remotion project with its own `package.json`:
`cd motion && npm run typecheck`.

## Invariants — don't break these

- **App and admin code is served only behind login.** `/protected` needs a
  session, `/admin` an admin session. Their files are cached privately.
- **`admin/` is a sibling of `protected/`, never inside it.** A static mount
  resolves `..` after its guard has matched, so a directory inside another
  mount is reachable through it (see the comment in `server.js` above the
  `/admin` mount, and the traversal tests in `test/integration`).
- **The boot overlay is each page's first frame.** `public/css/boot.css` and
  `public/js/boot.js` are inlined at the `<!-- klndr:* -->` markers, exactly
  once, with the script first in `<body>` (`server/pages.js`,
  `test/pages.test.js`). The login page has none.
- **`/assets/ElmsSans.ttf` is never versioned.** The preload in each page and
  the `@font-face` in `public/css/common.css` must name the same URL, or the
  font downloads twice.
- **Server-stored fields render as text.** A task's or category's `icon`,
  `color`, `source_app` and `default_timing`, and imported titles, are stored
  as sent. Never interpolate them into `innerHTML`: use
  `TimelineDOM.getCategoryIconElement`, `CategoryPicker.buildIcon`, or
  `escapeHtml` for chart tooltips.
- **Plugins get an API, never the DOM** (`docs/plugins-spec.md`). When a
  plugin needs richer UI, add a surface to the API.

## Conventions

- **Admin** is one page at `/admin` with a sidebar of sections. A new tool is
  one script that registers a section in `admin/shell.js`; navigation goes in
  the sidebar, page actions in the shared header. Don't change the
  announcement Studio's list, editor or stats layout without asking Yassen.
- **No intrusive main-screen chrome.** Secondary features live in menus with
  the quietest signal that works (a dot, only while relevant): no permanent
  labelled buttons, red count badges or attention animations.
- **Motion** reuses the reorder's slab lift and land (`var(--slab-float)`) for
  "picked up" moments. Animate with transform and opacity.
- **Comments** explain why, in full sentences, like the code around them.

## Workflow

- Commits: an imperative subject and one descriptive paragraph, no
  co-author trailer. Leave unrelated untracked files out.
- Work on a branch and open a PR; `main` deploys to production on push.
- **The repo is public.** A security fix ships to `main` (with Yassen's OK)
  before anything describing it is pushed anywhere else.
- `.claude/worktrees/` holds full copies of the repo; every tool config
  excludes it. Before acting on a defect report, check which commit it was
  read from: worktrees drift from `main`.
- To see a UI change, run the `klndr-e2e` launch config (port 3011,
  `MONGODB_DB=klndr_e2e`) rather than the dev database, and restart it after
  editing static files.
