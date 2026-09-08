<div align="center">

<img src="brand/png/klndr-lockup-card.png" alt="klndr" width="380">

**A fluid time-blocking workspace.**

Write down what you have to do, then drag it onto the week. The calendar pushes,
compresses and splits blocks around each other in real time, so a plan that no
longer fits rearranges itself instead of quietly overlapping.

[Quick start](#quick-start) · [Configuration](#configuration) · [Architecture](#architecture) · [API](#http-api) · [Integrations](#integrations) · [Deployment](#deployment)

</div>

---

## What klndr is

klndr is a self-hosted planner built around one idea: **a scheduled block is a
real object you can push, split, resize and finish on its own.** A task is what
you have to do; a *segment* is one block of it on the calendar. One task can be
three blocks across two days, each with its own start, length and completion
state.

Everything on the calendar obeys a small physics model. Drop a block onto an
occupied hour and the blocks in the way are displaced — compressed first if they
are unlocked, moved later if they are not — and the ghost preview shown mid-drag
is produced by the exact same call that runs on release, so the preview cannot
lie about the outcome.

### Features

- **Segment-based scheduling** — split a block, drag one piece to another day, tick off just that piece.
- **Live physics** — cascading ripple, compression of unlocked blocks, flow-around placement, and mirrored physics for dragging a block's leading edge into the past.
- **Canvas timeline** — three-surface renderer (scrolling body, frozen ruler, frozen gutter) with an interactive DOM overlay for cards, handles and seam grips.
- **Seam handles** — grab the boundary where two blocks touch and trade minutes between them without changing their total span.
- **Horizontal or vertical** — time can run across the screen or down it, with independently remembered zoom for each.
- **1, 3, 5 or 7 day views**, configurable snapping (header buckets or ruler ticks), and per-device orientation.
- **Undo/redo over gestures**, not snapshots — `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z`, `Ctrl+Y`.
- **Per-user categories** — a name, colour and icon, applied to tasks by name so a rename cascades server-side.
- **Tasks panel** with search, filters, inline creation, and a multi-column category board when the calendar is collapsed.
- **Mobile and touch** — pointer events throughout, long-press to drag, sticky mode chips replacing the modifier keys a finger cannot hold, and a phone tab bar.
- **Integrations** — pull outstanding work from other apps into the tasks panel; ticking it off writes back to the source.
- **Admin tooling** — beta account management, one-shot password resets, and in-app announcements.

### Keyboard and pointer

| Input | Effect |
| --- | --- |
| `Ctrl/Cmd + Z` | Undo (works with the calendar collapsed; never steals from a text field) |
| `Ctrl/Cmd + Shift + Z` / `Ctrl + Y` | Redo |
| `Esc` | Back out of the innermost thing — placement mode, then the top modal |
| `Shift` + drag | Snap to header buckets |
| `Ctrl/Cmd` + drag | Split around obstacles instead of pushing them |
| `Alt` + click | Split a block at the pointer |
| Long press (touch) | Begin a drag; shorter presses stay taps, so the list still scrolls |

---

## Quick start

**Requirements:** Node.js ≥ 20.19 (the MongoDB driver's floor) and a MongoDB
database — Atlas or local.

```bash
npm install
cp .env.example .env
npm start
```

Fill in `.env` before starting; every variable is documented inline. Then open
<http://localhost:3001/login> (or whichever `PORT` you set).

When the `users` collection is empty, a default admin `yassen` / `password123`
is seeded. **Change it immediately after your first sign-in.**

Use a development database name via `MONGODB_DB` (for example `klndr_dev`) so
local work never touches production data.

### npm scripts

| Script | Purpose |
| --- | --- |
| `npm start` | Run the server |
| `npm run dev` | Run with `node --watch` |
| `npm run add-user -- <username> <password> [role]` | Create an account (`role` is `user` or `admin`) |
| `npm run list-users` | List accounts |
| `npm run delete-user -- <username>` | Delete an account |
| `npm run reset-password -- <username>` | Issue a one-shot temporary password |

`reset-password` prints the temporary password once, signs out every session for
that account, and forces a password change at next login. No klndr account
carries an email address, so this is deliberately an out-of-band,
admin-mediated path — hand the password over directly.

---

## Configuration

All configuration is environment variables. Nothing has a silent default: a
quietly-defaulted secret is worse than a crash, because everything appears to
work.

| Variable | Required | Description |
| --- | --- | --- |
| `MONGODB_URI` | yes | MongoDB connection string. |
| `MONGODB_DB` | | Database name. Defaults to `klndr`; use `klndr_dev` locally. |
| `PORT` | | HTTP port. Defaults to `3000`. |
| `SESSION_SECRET` | yes | Cookie signing secret. Keep it identical across every instance of one deployment. |
| `KLNDR_BASE_URL` | for integrations | This deployment's absolute public origin. Used to build OAuth redirect URIs, which must byte-match what the provider has registered — behind a proxy the `Host` header is not reliably the public name, so it cannot be derived from the request. |
| `INTEGRATION_ENC_KEY` | for integrations | 32 random bytes, base64. Encrypts integration tokens at rest with AES-256-GCM. Rotating it makes existing connections unreadable and forces everyone to reconnect. |
| `SYLLA_BASE_URL`, `SYLLA_CLIENT_ID`, `SYLLA_CLIENT_SECRET` | for Sylla | See [Integrations](#integrations). Omit them and Sylla simply lists as "Not configured"; nothing else is affected. |

Generate an encryption key with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

> klndr's own session tokens are stored in the clear — they only unlock klndr.
> An integration's refresh token unlocks a *different* system, which is why that
> one is encrypted.

---

## Architecture

A plain Express server, a MongoDB store, and a dependency-free browser client.
No build step, no bundler, no framework: the protected app is served as static
files behind a session guard.

```
server.js                    Express app — auth, tasks, settings, categories, announcements
server/
  auth-middleware.js         Session resolution, API vs. page guards, admin guard, reset gate
  db.js / db-mongodb.js      Data layer, indexes, first-run admin seed
  categories.js              Per-user categories, rename cascade, legacy migration
  routes/integrations.js     OAuth navigation routes and integration XHR endpoints
  integrations/
    connector.js             The contract every provider implements (documentation, not code)
    registry.js              Provider id -> connector
    oauth-client.js          OAuth 2.0 + PKCE client
    crypto.js                AES-256-GCM for tokens at rest
    tokens.js                Access-token cache and refresh
    sync.js                  NormalizedItem <-> klndr task
    sylla.js                 The one shipped connector

protected/                   Served only to an authenticated session
  index.html
  js/
    app.js                   Application coordinator: state, loading, commits, undo wiring
    api.js                   Fetch wrapper; a 401 clears local state and redirects
    palette.js               The 20 colours and 20 icons — required by the server too
    task-model.js            Task/segment model, derived fields, legacy migration on read
    physics-engine.js        Ripple, compression, flow-around placement, mirrored physics
    timeline-canvas.js       Canvas renderer: body, ruler and gutter surfaces
    timeline-dom.js          Interactive overlay: cards, handles, seams, ghosts, tooltips
    drag-controller.js       One resolver drives both the live preview and the commit
    sidebar.js               Tasks panel, filters, multi-column board
    category-picker.js       One picker shared by the inline bar and the block editor
    history.js               Undo/redo stack of gestures

public/                      Login page, brand assets, fonts — unauthenticated
brand/                       Logo kit, source SVGs, PNG renders (see brand/README.md)
scripts/                     Account CLI, brand asset build
docs/                        Manual regression checklists
```

### Notable design decisions

- **The physics engine works on segments, not tasks.** A task's own blocks are ordinary obstacles to each other — that is what makes a block independently pushable.
- **One drag resolver.** `resolveDragOutcome()` produces both the on-screen ghost and the committed result, so a preview and its outcome cannot diverge.
- **Ids are minted client-side.** A new task appears and is editable before the create request is sent; the server keeps whatever id it is handed, so nothing needs reconciling.
- **Optimistic writes with a revision guard.** Every local edit bumps a task's revision, and a server response may only overwrite a task whose revision still matches.
- **Derived fields stay on the wire.** `segments` is authoritative in memory, while `start_times` / `durations` / `total_duration` / `completed` are kept in sync so date-range queries work against records written before segments existed.
- **The palette is shared, not duplicated.** `protected/js/palette.js` is loaded as a browser global *and* `require`d by the server, because "pick a colour no other category has taken" is only meaningful if both sides draw from the same twenty.
- **Undo stores changes, not snapshots.** Each entry carries the before and after of the fields one gesture touched, so undo and redo are the same replay in opposite directions.

### Data model

MongoDB collections: `users`, `sessions`, `tasks`, `settings`, `announcements`,
`integrations`. Indexes are created on first connect; sessions expire through a
TTL index on `expires_at`.

A **task** owns its identity — title, colour, icon, category, lock state — and
carries `segments`, each `{ id, start_time, duration, completed }`. Imported
tasks additionally carry generic `source_app` / `source_id` / `source_url` /
`source_revision` / `source_completed` fields; no provider is ever named in the
schema.

### Categories

A category is a name plus a default colour and icon, and it belongs to the
person — klndr ships none. Picking one while writing a task hands over its
colour and icon; change either afterwards and your choice stands. Tasks
reference a category **by name**, so a rename cascades to every task
server-side. Changing a colour asks before repainting the tasks already using
it, and says how many there are.

A task with no category is genuinely uncategorised: it keeps a plain colour,
gets no filter pill of its own, and lands in an "Uncategorized" board column
that only appears while something is in it.

> **Migration.** A user who predates categories is migrated the first time
> `/api/categories` is read, deriving the list from the categories their tasks
> actually carry, each taking the colour and icon most of its own tasks already
> wear. Categories that only ever existed as a menu entry are not recreated. The
> *absence* of `values.categories` marks a user as unmigrated, so an empty array
> means "migrated, and deliberately empty" and is never re-derived.

---

## HTTP API

Every endpoint below `/api` except the auth routes requires a session — a
`klndr_session` cookie, or `Authorization: Bearer <token>` for scripts and the
desktop wrapper. While a password reset is pending, every endpoint except
`/api/auth/me`, `/api/auth/logout` and `/api/auth/change-password` returns
`403 { code: "password_change_required" }`.

<details>
<summary><strong>Auth</strong></summary>

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/auth/login` | Sign in; sets a 30-day httpOnly cookie |
| `POST` | `/api/auth/logout` | Destroy the session |
| `GET` | `/api/auth/me` | Current user |
| `POST` | `/api/auth/change-username` | Change username |
| `POST` | `/api/auth/change-password` | Change password |

</details>

<details>
<summary><strong>Tasks, settings and categories</strong></summary>

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/tasks?startDate&endDate` | Tasks overlapping a date range, plus everything unscheduled |
| `POST` | `/api/tasks` | Create |
| `PUT` | `/api/tasks/:id` | Update |
| `POST` | `/api/tasks/batch-update` | Apply an array of updates in one request |
| `DELETE` | `/api/tasks/:id` | Delete |
| `GET` / `PUT` | `/api/settings` | Read and update per-user settings |
| `GET` | `/api/categories` | List (migrating a legacy user on first read) |
| `POST` | `/api/categories` | Create |
| `PUT` | `/api/categories/:id` | Update; `applyToTasks` repaints existing tasks |
| `DELETE` | `/api/categories/:id` | Delete |

Recolouring runs server-side because the client only holds the current range
plus everything unscheduled — it can neither count the affected tasks honestly
nor reach all of them.

</details>

<details>
<summary><strong>Announcements</strong></summary>

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/announcements` | All announcements plus the caller's last-seen id |
| `GET` | `/api/announcements/missed` | Only those newer than the caller's last-seen id |
| `POST` | `/api/announcements` | Create *(admin)* |
| `PUT` | `/api/announcements/seen` | Advance the caller's last-seen id |

</details>

<details>
<summary><strong>Admin</strong></summary>

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/admin/users` | List accounts |
| `POST` | `/api/admin/create-user` | Create an account |
| `DELETE` | `/api/admin/users/:username` | Delete an account |
| `POST` | `/api/admin/users/:username/reset-password` | Issue a temporary password, returned exactly once |

</details>

<details>
<summary><strong>Integrations</strong></summary>

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/integrations` | Providers and connection status |
| `GET` | `/api/integrations/:provider/connect` | Begin OAuth *(top-level navigation)* |
| `GET` | `/api/integrations/:provider/callback` | OAuth callback *(top-level navigation)* |
| `POST` | `/api/integrations/:provider/sync` | Sync now; `{ force: true }` bypasses the 5-minute throttle |
| `POST` | `/api/integrations/:provider/push` | Push one task's completion to the source immediately |
| `POST` | `/api/integrations/:provider/undismiss` | Restore locally-deleted imported items and re-sync |
| `DELETE` | `/api/integrations/:provider` | Revoke at the source and disconnect |

The two navigation routes use a redirect-to-login guard rather than a JSON 401,
because the browser is following a redirect and would otherwise render raw JSON.

</details>

---

## Integrations

klndr can pull outstanding work from other apps into the tasks panel. Imported
work arrives **unscheduled**, so you drag it onto the week yourself, and ticking
it off updates the source app too.

The governing rule: **the source owns what the work is; klndr owns when it
happens and what it looks like.** Titles, category names and completion come
from the source. Segments, start times and durations are the person's and are
never written by a sync.

The plumbing is provider-agnostic. `server/integrations/registry.js` maps a
provider id to a connector implementing the interface documented in
`server/integrations/connector.js`. Nothing else in the codebase names a
provider: tasks carry generic `source_*` fields and the routes are
`/api/integrations/:provider/...`.

### Adding a provider

One new file plus one registry entry. Implement `isConfigured`, `beginAuth`,
`completeAuth`, `refresh`, `identify`, `fetchItems`, `pushCompletion` and
`revoke`, returning `NormalizedItem`s — `sync.js` sees that shape and nothing
else.

A connector sends a plain subject name, never a decorated one. The only
exception is a name that would be ambiguous *for that person*: if two subjects
on their own syllabus share a name, those two get the professor spelled out so
they do not collapse into one column. Anything the source knows that klndr has
no field for is kept verbatim on the task under `metadata.source`.

### Connecting Sylla

1. Sign in to Sylla, open **Sylla for developers** from the account menu, and register an app.
2. Set its redirect URI to `<KLNDR_BASE_URL>/api/integrations/sylla/callback`, matched exactly.
3. Tick the scopes `profile.read`, `sessions.read`, `progress.read`, `progress.write`.
4. Copy the client ID and secret (the secret is shown once) into `SYLLA_CLIENT_ID` and `SYLLA_CLIENT_SECRET`, and set `SYLLA_BASE_URL` to Sylla's origin.
5. Restart, then use **Account & Settings → Integrations → Connect**.

Running both locally means running them on different ports: Sylla defaults to
`3000`, so klndr should use `PORT=3001`.

---

## Deployment

klndr ships as a single Node process and deploys to Vercel as a serverless
function (`vercel.json` routes everything to `server.js`).

1. Import the repository into Vercel.
2. Leave the framework preset as **Other** and keep the build and output settings empty.
3. Add the production environment variables from [Configuration](#configuration) — at minimum `MONGODB_URI`, `MONGODB_DB` (for example `klndr`, *not* `klndr_dev`) and `SESSION_SECRET`, plus `KLNDR_BASE_URL` and `INTEGRATION_ENC_KEY` if you use integrations.
4. Deploy.

Configure MongoDB Atlas network access for your own machine (local) and for
Vercel. Any other Node host works too — `npm start` is the whole run command.

---

## Testing

`test-e2e.js` is a raw-`http` smoke test of the API: auth redirects, session
handling and task CRUD. Start the server, then:

```bash
node test-e2e.js
```

There is no DOM test framework in this repository, so geometry, input and layout
are covered by a manual checklist:
[`docs/mobile-regression-checklist.md`](docs/mobile-regression-checklist.md).
Run it after any change to the timeline renderer, the drag controller, the
layout controller or `responsive.css`. Two of its checks are free and should be
done first — load `/?debug=geom` and confirm the console prints
`[klndr geom] ok:` with no problem list, at every day count.

---

## Brand

The logo kit lives in [`brand/`](brand/README.md): source SVGs, 2× PNG renders,
an animated lockup, and the ElmsSans typeface. The shipped favicons and touch
icon are generated from it:

```bash
node scripts/build-brand-assets.js
```

---

## Security notes

- Passwords are hashed with bcrypt; sessions are httpOnly cookies backed by a TTL-indexed server record, and `secure` in production.
- The forced-password-change gate is enforced in middleware, not in the UI — a client-side overlay would leave every data endpoint reachable with a temporary password.
- Integration refresh tokens are encrypted at rest with AES-256-GCM. OAuth uses PKCE, and the verifier and state are never sent to the browser in readable form.
- Change the seeded `yassen` / `password123` admin before exposing an instance.
- No account carries an email address, so the only recovery path is an admin-issued temporary password handed over out-of-band.

---

## License

ISC. See [`package.json`](package.json).
