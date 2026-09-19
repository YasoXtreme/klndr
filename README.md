<div align="center">

<img src="brand/png/klndr-lockup-card.png" alt="klndr" width="380">

**A fluid time-blocking workspace.**

Write down what you have to do, then drag it onto the week. The calendar pushes,
compresses and splits blocks around each other in real time, so a plan that no
longer fits rearranges itself instead of quietly overlapping.

[Quick start](#quick-start) · [Configuration](#configuration) · [Architecture](#architecture) · [API](#http-api) · [Announcements](#announcements) · [Integrations](#integrations) · [Deployment](#deployment)

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
- **Announcements** — posts written in a dedicated studio with a live preview. The header can be an image, a GIF, an SVG, a video, a Lottie file or a built-in motion scene. Each post chooses how it arrives (a story, a banner, a corner card, or inbox only), who it is for, when it goes live and expires, and whether it has reactions and a button. People who join later are not handed the backlog.
- **Admin tooling** — one admin page at `/admin`, with a sidebar of sections: analytics, the announcement studio, and accounts (create, one-shot password resets, delete). A new tool is one script that registers a section.

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
| `npm run add-user -- <username> [role]` | Create an account with a one-shot temporary password (`role` is `user` or `admin`) |
| `npm run list-users` | List accounts |
| `npm run delete-user -- <username>` | Delete an account |
| `npm run reset-password -- <username>` | Issue a one-shot temporary password |
| `npm test` | Unit tests: announcement rules and markdown, media policy, motion scenes, page caching, the boot overlay |
| `npm run check:tokens` | Design-token lint across the stylesheets, including the motion scenes' theme copy |
| `npm run r2:check` | Check the R2 credentials, bucket and CORS, with a write/read/delete round trip |
| `npm run r2:cors [-- <origin> ...]` | Write the bucket CORS policy that browser uploads need |
| `npm run vendor` | Refresh the vendored browser libraries (lottie-web light, fflate) from `node_modules` |

`add-user` and `reset-password` both print a generated temporary password once
and force a password change at next login; `reset-password` also signs out
every session for that account. Admins never choose a password for anyone. No klndr account
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
| `ANALYTICS_TZ` | | IANA timezone the analytics page reports in. Activity is stored in UTC and converted on read, so changing this re-labels history rather than rewriting it. Defaults to `UTC`. |
| `KLNDR_BASE_URL` | for integrations | This deployment's absolute public origin. Used to build OAuth redirect URIs, which must byte-match what the provider has registered — behind a proxy the `Host` header is not reliably the public name, so it cannot be derived from the request. |
| `INTEGRATION_ENC_KEY` | for integrations | 32 random bytes, base64. Encrypts integration tokens at rest with AES-256-GCM. Rotating it makes existing connections unreadable and forces everyone to reconnect. |
| `SYLLA_BASE_URL`, `SYLLA_CLIENT_ID`, `SYLLA_CLIENT_SECRET` | for Sylla | See [Integrations](#integrations). Omit them and Sylla simply lists as "Not configured"; nothing else is affected. |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | for media uploads | A Cloudflare R2 bucket plus an API token with **Object Read & Write** on it. See [Setting up Cloudflare R2](#setting-up-cloudflare-r2). Without these, header uploads are switched off; motion scenes still work. |
| `R2_PUBLIC_BASE_URL` | | The bucket's public origin: a custom domain or its `r2.dev` URL. Without it the bucket stays private and klndr signs every read, so media only loads for signed-in people. |
| `KLNDR_DELAY_MS` | | Local only: holds every API call and page back by this many milliseconds, so the loading screen and its slow states can be worked on. Files are never delayed, and it is ignored on Vercel. |

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
server.js                    Express app — auth, tasks, settings, categories, route mounts
server/
  auth-middleware.js         Session resolution, API vs. page guards, admin guard, reset gate
  db.js / db-mongodb.js      Data layer, indexes, first-run admin seed
  categories.js              Per-user categories, rename cascade, legacy migration
  http-error.js              HttpError, and the JSON route wrapper that answers with it
  activity.js                Daily activity rows for analytics
  analytics.js               Admin analytics: report metadata and coverage
  analytics-reports.js       The analytics reports themselves
  announcements/
    model.js                 Legacy posts read as current ones; the people and studio views of a post
    validate.js              Field cleaning, and what a post needs before it can go live
    service.js               Feed, receipts and reactions; the studio's lifecycle actions
  media.js                   Media registry: upload handshake, library, /media/* reads
  media-policy.js            Kinds, limits, object keys, SVG and Lottie inspection
  storage/r2.js              Cloudflare R2 over the S3 API: presigned PUT/GET, HEAD, CORS
  routes/
    announcements.js         /api/announcements
    admin-announcements.js   /api/admin/announcements
    admin-media.js           /api/admin/media
    analytics.js             /api/admin/analytics
    integrations.js          OAuth navigation routes and integration XHR endpoints
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
    announcements/
      rules.js               Who a post is for, when it is delivered and read — the server requires it too
      markdown.js            Escape-first Markdown for post bodies, and the legacy three-rule markup
      media-view.js          A post's header: image, SVG, video, Lottie or motion scene
      reader.js              One post, drawn the same for the reader, stories and the studio preview
      inbox.js               Unread dot and menu entry, inbox, reader, stories, banner and corner card
    motion/
      motion-core.js         Springs, easing, seeded randomness, theme tokens, canvas text
      scenes.js              The built-in motion scenes: in, idle and out, each a pure function of its clock
      motion-timeline.js     What plays when: clips, idle, loop or play once, the progress bar — the server requires it too
      motion-player.js       Canvas player: pauses offscreen and hidden, respects reduced motion
  css/announcements.css      Everything announcement-shaped a person sees
  vendor/                    lottie-web (light build) and fflate, copied by npm run vendor

admin/                       The admin page, /admin — every URL under it serves index.html
  index.html, shell.js       Sidebar, page header, router, shared dialogs and menus
  admin.css                  The shell's layout
  analytics.*, charts.js     Analytics section, and the cards, tables and charts every section uses
  announcements.*            Announcements section — the announcement studio
  studio/                    Studio views: list, editor and its sections, uploads, preview, stats
  accounts.js                Accounts section

public/                      Login page, brand assets, fonts — unauthenticated
brand/                       Logo kit, source SVGs, PNG renders (see brand/README.md)
motion/                      Remotion workspace for header clips; never deployed (see motion/README.md)
scripts/                     Account CLI, brand asset build, design-token lint, R2 setup, vendoring
test/                        Unit tests (node --test)
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
- **Analytics reports its own blind spots instead of backfilling them.** klndr recorded nothing temporal before the analytics feature — no last login, no `tasks.created_at`, no activity log — and `updated_at` is an *upper bound* on creation, so deriving a creation date from it would drag every task forward in time and make the earliest weeks look empty, undetectably and permanently. Nothing is backfilled. Every report instead returns `meta.instrumented_since` and `meta.coverage`, probed from the data rather than hardcoded, and the page renders the gap ("1,290 tasks predate instrumentation") so totals stay reconcilable. The one exception is *derived at read time*, never stored: a missing `last_login_at` falls back to the newest surviving session row and is tagged `last_login_source`, so it self-heals as real logins arrive.
- **New members do not inherit the announcement backlog.** A post reaches someone's badge or pops up for them only if they already had an account when it went live (or when it was last sent again), unless the post says "also show to people who join later". Older posts still sit in their inbox, already marked read. Before this, a new account's read watermark started at `0`, so every announcement ever posted played at their first sign-in.
- **Read state is per post, not a watermark.** A receipt per person per post records delivery, opening, dismissal, button click and reaction, stamped with the delivery version it belongs to. "Notify again" makes a post unread for everyone without erasing anyone's history. Posts from before receipts still honour the old `last_seen_announcement_id` watermark, read at request time; nothing was backfilled.
- **Media bytes never pass through Express.** Vercel caps a function body at 4.5 MB. So the studio asks the server for presigned R2 URLs, with type, size and cache headers bound into the signature, and uploads straight to the bucket with a progress bar. The server then confirms the object with a HEAD request, and reads SVG and Lottie files to reject anything scriptable.
- **One motion scene, two renderers.** A scene animates in, stays idle - still moving - for as long as it is asked to, then animates out. It is a pure function from its clock (frames since it began, and frames since its out began) to canvas drawing, so any length of idle joins its out without a jump. The app's player and the Remotion workspace in `motion/` run the same timeline and the same functions, so a rendered clip matches the in-app scene frame for frame, and a resting pose costs nothing to show under reduced motion.
- **Files are cached by what is in them.** Every page is served through `server/pages.js`, which stamps each local stylesheet and script URL with a hash of the file's contents. A URL naming the current hash is cached for a year and never asked about again; editing the file changes its URL. The pages themselves are always revalidated, which is how a deploy reaches everyone. The app's and admin's files stay behind their login guards and are only ever cached privately, in the browser that was allowed to fetch them.
- **The loading screen is the page's first frame.** `public/css/boot.css` and `public/js/boot.js` are written into each page by the server rather than linked, so the logo never waits on a file of its own. It animates on the compositor only (transform and opacity) so it stays smooth while the page's scripts compile, holds a fast load for no longer than its entrance, and then flies each part of the logo onto the page's own brand - the topbar, or admin's sidebar - landing on it exactly.
- **One logo carries you between the app and admin.** A link marked `data-boot-leave` hands the click to `KlndrBoot.leave()`, which starts the navigation in the same breath and plays over the wait rather than before it. The logo lifts off the brand of the page being left, turns into the destination's - the plate turning over to a shield and the admin tag popping out, or the tag staying behind on the way back - and the next page picks the same motion up from the very frame the last one stopped on, worked out from when its own response began. So a slow server makes the trip longer, never jumpier. A page with unsaved work registers `KlndrBoot.guard()` and keeps the browser's own prompt instead.
- **A run of clips is one camera move, not clips glued together.** Each clip is a panel on klndr's board, laid out left to right like days on the calendar. Just before a clip's out, the camera lifts its panel off the board and slides to the next one, which starts arriving while it is still sliding in; what the panels carry lags a touch as the camera sets off and runs on a touch as it stops. So the leaving clip is still on screen while the next one builds, and no moment is empty. The same move joins every pair of clips, the last back to the first included, and it is planned in `motion-timeline.js`, so the player, the scrubber and a Remotion render share it. Between moves, a clip draws exactly as it does on its own.

### Data model

MongoDB collections: `users`, `sessions`, `tasks`, `settings`, `announcements`,
`announcement_receipts`, `media`, `counters`, `integrations`, `activity_daily`.
Indexes are created on first connect; sessions expire through a TTL index on
`expires_at`.

**`activity_daily`** is one document per person per UTC day, keyed
`"<YYYY-MM-DD>:<user_id>"` — day first, so a date range across everyone is a
contiguous scan rather than one scattered by user. It carries `first_at`,
`last_at`, `pings` and `hours`, and is written at most once per five minutes per
person from a compare-and-swap in `requireApiAuth`. `pings` counts *distinct
five-minute windows*, not requests, which is what makes `pings x 5min` a usable
(and clearly labelled) proxy for time on the app; `hours` is a subdocument of
counters rather than an array, because `$inc` on `hours.14` creates the object by
itself on upsert whereas a pre-seeded 24-slot array collides with that same
`$inc`. It has **no TTL**: its whole value is longitudinal, and a TTL would
quietly amputate the retention grid a year from now.

A **task** owns its identity — title, colour, icon, category, lock state — and
carries `segments`, each `{ id, start_time, duration, completed }`. Imported
tasks additionally carry generic `source_app` / `source_id` / `source_url` /
`source_revision` / `source_completed` fields; no provider is ever named in the
schema.

An **announcement** has four groups of fields:
- **Words:** `title`, `summary`, a Markdown `body` and a `kind`.
- **Header:** `media`. This is an uploaded file referenced by `media_id`, or motion: `scene: { loop, clips: [{ id, props, hold }] }`, plus alt text and framing. Posts saved before clips existed stored `scene: { id, props }`; they are read as one looping clip with two seconds of idle.
- **Extras:** an optional `cta` button and `reactions_enabled`.
- **Sending:** `delivery`, `audience`, `evergreen`, `pinned`, `publish_at` and `expires_at`.

The stored `status` is only ever `draft`, `published` or `archived`. Scheduled,
live and expired are derived from the dates. `revision` guards the studio's
autosave, and `delivery_version` goes up each time a post is sent again. Ids come
from an atomic counter in `counters`. Posts written before the studio have no
`status`; they are read as published stories in the old three-rule markup and
are never rewritten.

**`announcement_receipts`** holds one document per person per post, keyed
`"<announcement_id>:<user_id>"`. It records the first `delivered_at`,
`opened_at`, `dismissed_at` and `cta_at`, the `reaction`, and the delivery
`version` those belong to. Deleting a post or an account deletes its receipts.

**`media`** is the upload registry. Each entry has the R2 object key, kind, type,
size, dimensions, duration and poster, plus a `status` that stays `pending` until
the server has verified the upload. Objects live under
`announcements/<yyyy>/<mm>/<media id>/`. A file that any post still uses cannot
be deleted. Pending uploads older than 24 hours are swept whenever the library
is opened.

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
| `GET` | `/api/announcements/feed` | Every post the caller can see, each with `read`, `deliverable`, their `reaction` and the reaction counts, plus the `unread` count |
| `GET` | `/api/announcements/pulse` | Only the unread count and the newest deliverable post; the app polls this |
| `GET` | `/api/announcements/:id` | One post, for a deep link. `404` if it is not live or not for the caller |
| `POST` | `/api/announcements/:id/receipts` | `{ event }`: `delivered`, `opened`, `dismissed` or `cta` |
| `PUT` | `/api/announcements/:id/reaction` | `{ reaction }`: `tada`, `heart`, `fire`, `clap`, `eyes`, or `null` to remove it |
| `POST` | `/api/announcements/read-all` | Mark everything read |

`GET /media/*` serves uploaded files to a signed-in session. It redirects to the
public URL when `R2_PUBLIC_BASE_URL` is set, and otherwise to a short-lived
signed read URL.

</details>

<details>
<summary><strong>Admin</strong></summary>

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/admin/users` | List accounts |
| `POST` | `/api/admin/create-user` | Create an account; its temporary password is returned exactly once |
| `DELETE` | `/api/admin/users/:username` | Delete an account |
| `POST` | `/api/admin/users/:username/reset-password` | Issue a temporary password, returned exactly once |
| `GET` | `/api/admin/analytics/overview` | Instance totals, active accounts, signup and task-creation trends |
| `GET` | `/api/admin/analytics/users` | One row per account: activity, task counts, sessions, streaks |
| `GET` | `/api/admin/analytics/engagement` | DAU/WAU/MAU, new vs returning, retention cohorts, activity heatmap |
| `GET` | `/api/admin/analytics/tasks` | Task and scheduling shape, planned-time heatmaps, shared categories |
| `GET` | `/api/admin/analytics/system` | Sessions, integrations, announcements, settings distribution |

All five take `?days=` (clamped to 7–3650) and return a `meta` block describing
what was measurable over that range. The page itself is `GET /admin/analytics`;
`/analytics` redirects there.

**Task content is never exposed.** No title and no note leaves these endpoints,
and a category name appears only pooled instance-wide once **two distinct
accounts** use it — enforced in the aggregation pipeline, not in the template, so
no change to the page can leak one.

Everything under `/api/admin/` is excluded from activity tracking, so an admin
watching the dashboard or writing a post does not register as engagement.

</details>

<details>
<summary><strong>Announcement studio and media</strong> <em>(admin)</em></summary>

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/admin/announcements` | Every post with its studio status and reach: audience, delivered, opened, clicked, reactions |
| `POST` | `/api/admin/announcements` | Create a draft |
| `GET` | `/api/admin/announcements/:id` | One post with its header file, per-person receipts and stats |
| `PUT` | `/api/admin/announcements/:id` | Save. Takes the `revision` last seen, and answers `409` with the stored post if someone saved in between |
| `GET` | `/api/admin/announcements/:id/preview` | The post as a person would receive it, whatever its status or audience ("Preview in app") |
| `POST` | `/api/admin/announcements/:id/publish` | Publish now, or schedule with `{ publish_at }` in Unix seconds. `422` lists what is missing |
| `POST` | `/api/admin/announcements/:id/unpublish` | Back to drafts |
| `POST` | `/api/admin/announcements/:id/archive` | Take it down but keep it |
| `POST` | `/api/admin/announcements/:id/redeliver` | "Notify again": unread and delivered afresh for the whole audience |
| `POST` | `/api/admin/announcements/:id/duplicate` | Copy into a new draft |
| `DELETE` | `/api/admin/announcements/:id` | Delete it and its receipts. Uploaded files stay in the library |
| `GET` | `/api/admin/media/status` | Whether R2 is configured, public or private mode, and the upload limits |
| `GET` | `/api/admin/media` | The media library, with the posts using each file |
| `POST` | `/api/admin/media/uploads` | Validate a file and return presigned `PUT` URLs for it and its poster |
| `POST` | `/api/admin/media/:id/complete` | Verify the uploaded object and mark it ready |
| `DELETE` | `/api/admin/media/:id` | Delete a file. `409` while a post still uses it |

Every status change (`publish`, `unpublish`, `archive` and `redeliver`) also
takes `{ revision }`, so nobody publishes a version of a post they have not
seen. Studio requests are excluded from activity tracking, like every other
admin request.

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

## Announcements

Admins write posts in the announcement studio, the Announcements section of the
admin page at **/admin/announcements** (**Admin** in the account menu). Everyone
finds posts under **What's new** in the account menu, and each post also arrives
the way it was sent.

### Writing a post

- **Header.** Upload an image, an animated GIF, PNG or WebP, an SVG, an MP4 or WebM video, or a Lottie file: drop it, paste it, pick it, or reuse one from the library. Or choose one of fifteen **motion scenes** - a big reveal, a checklist, a cursor flipping a switch that floods the header with colour, a calendar tearing through to a date, a milestone counting up, a swinging heads-up sign, a star rating and more - and edit its words and colours, or line up to six **clips**, each its own scene with its own words and colours, to play one after another: add, reorder by dragging, and remove them in a strip. Motion can **play once** - every clip plays through, then the last one stays in its idle state - or **loop**, back to the first clip after the last; each clip idles for as long as its slider says before it animates out. Clips hand over in one camera move along klndr's board, so a run plays as a single animation. The story's progress bar fills on the way in, or once per loop, and the preview marks where clips hand over. Scenes are drawn live, follow the reader's theme and need no download. Framing covers aspect ratio, fit, focal point, background and alt text.
- **Body.** Markdown with a toolbar: headings, lists, checklists, callouts (`> [!TIP]`), code, keycaps (`[[Ctrl+Z]]`), links, and images pasted or dropped straight in.
- **Button and reactions.** An optional button that opens a link or a klndr screen (categories, integrations, settings, account, analytics), and 🎉 ❤️ 🔥 👏 👀 reactions.
- **Delivery.**
  - *Story* opens a short stepper the next time someone arrives.
  - *Banner* floats a notice under the top bar.
  - *Corner card* slides in at the bottom right.
  - *Inbox only* just lights the badge.

  A post that goes live while someone is already in the app reaches them as a corner card, never as a story. Anyone can switch pop-ups to "Inbox only" in Settings.
- **Audience and timing.** Everyone, admins only, or specific people. Publish now or schedule it, set an optional expiry, pin it, and choose whether it also shows to people who join later.

The studio autosaves:
- **Preview.** Shows the post as a story, inbox row, banner or card, in light or dark.
- **Preview in app.** Plays the real arrival flow without recording anything.
- **Notify again.** Sends a live post out again.
- **Stats.** Every post has a view with reach, opens by day, reactions, and who has opened it.

`/?announcement=<id>` links straight to a post.

### Setting up Cloudflare R2

Uploads go straight from the studio to an R2 bucket; klndr only signs the
requests. Motion scenes need none of this.

1. In the Cloudflare dashboard, open **R2** and create a bucket.
2. Choose how files are read:
   - **Public:** connect a custom domain to the bucket (or enable its `r2.dev` URL for testing), and set `R2_PUBLIC_BASE_URL` to that origin.
   - **Private:** leave `R2_PUBLIC_BASE_URL` empty. klndr redirects `/media/*` to short-lived signed URLs, so files only load for signed-in people.
3. Under **R2 → Manage API tokens**, create a token with **Object Read & Write** on the bucket. Set the following in `.env`, and in Vercel for production:
   - `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` from that token;
   - `R2_ACCOUNT_ID` from the R2 overview page;
   - `R2_BUCKET`.
4. Allow browser uploads. `npm run r2:cors` writes a CORS policy for `KLNDR_BASE_URL` and `http://localhost:3001`; name any other origins after `--`. Writing it needs an **Admin Read & Write** token. With the object token, the command prints the JSON to paste into the bucket's **Settings → CORS policy** instead.
5. Run `npm run r2:check`. It checks the credentials, the bucket, and the CORS policy for each origin, then round-trips a small test object.

Files can be up to 10 MB for images, 20 MB for animated images, 2 MB for SVG,
50 MB for video and 5 MB for Lottie. An SVG is refused if it contains scripts,
event handlers, `javascript:` links, embedded HTML or documents, XML entities,
or references to other hosts. SVG is only ever displayed through `<img>`.

### Motion clips

`motion/` is a separate [Remotion](https://www.remotion.dev) workspace for
designing header videos. It renders the app's built-in scenes with the same code
the app plays, and includes two free-form React clips to start from,
`FeatureSpotlight` and `WeekRecap`:

```bash
cd motion
npm install
npm run studio
npm run render -- FeatureSpotlight
```

Then upload `motion/out/FeatureSpotlight.mp4` as a post's header. The workspace
is never deployed. [`motion/README.md`](motion/README.md) covers making clips,
render options, and Remotion's licence.

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
3. Add the production environment variables from [Configuration](#configuration) — at minimum `MONGODB_URI`, `MONGODB_DB` (for example `klndr`, *not* `klndr_dev`) and `SESSION_SECRET`, plus `KLNDR_BASE_URL` and `INTEGRATION_ENC_KEY` if you use integrations, and the `R2_*` variables for announcement media.
4. Deploy.

Configure MongoDB Atlas network access for your own machine (local) and for
Vercel. Any other Node host works too — `npm start` is the whole run command.

Two Vercel settings matter more to how fast klndr feels than anything in the
code, both under **Settings → Functions**:

- **Function region.** Put it in the same region as the Atlas cluster. Every
  API call makes a few database round trips one after another, so a function
  on another continent from its database pays that distance several times per
  request. The second part of a response's `x-vercel-id` header names the
  region a request ran in.
- **Fluid compute.** On. Without it, a page's parallel requests can each wake a
  separate cold instance.

Every response carries a `Server-Timing` header with the session lookup's cost
(`auth`) and marks an instance's first request (`cold`), so both show up in the
browser's network panel.

---

## Testing

The unit tests need no server and no database:

```bash
npm test
npm run check:tokens
```

They cover:
- the announcement rules, including someone who joins after thirty posts;
- Markdown escaping and the legacy renderer;
- media validation and signed upload URLs;
- the motion helpers, the scenes' determinism, and their in, idle and out: an empty stage at both ends after any idle, no jump into the out, and an intro that has really finished when it says so;
- the motion timeline: clips, loop and play-once progress, and edits that keep the preview's place;
- the camera move between clips: when it sets off and where the next clip starts, no jolt at either end, never an empty frame once the animation has begun, every pass after the first drawn the same, a clip between moves drawn exactly as on its own, and a looping video without a seam.

`test-e2e.js` is a raw-`http` smoke test of the API: auth redirects, session
handling, task CRUD and the announcement lifecycle. Start the server, then:

```bash
node test-e2e.js
```

It signs in as the seeded `yassen` admin. Once that password has been changed,
name the account with `E2E_USERNAME` and `E2E_PASSWORD`. The run changes that
password and then restores it.

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
