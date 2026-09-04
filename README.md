# Klndr

## Run locally

1. Copy `.env.example` to `.env` and fill it in (every variable is documented there).
2. Use a **dev** database name via `MONGODB_DB` (default in `.env` is `klndr_dev`) so local data stays separate from production.
3. Install and start:

```bash
npm install
npm start
```

Open <http://localhost:3000/login>.

## Deploy to Vercel

1. Import this repository into Vercel.
2. Leave the framework preset as **Other** and keep the build and output settings empty.
3. Add these production environment variables:
   - `MONGODB_URI`: your MongoDB Atlas connection string (can match local).
   - `MONGODB_DB`: production database name, for example `klndr` (not `klndr_dev`).
   - `SESSION_SECRET`: a long random value. Use the same value for every production deployment.
   - `KLNDR_BASE_URL`: this deployment's public origin, for example `https://klndr.example.com`. Used to build OAuth redirect URIs, which must match what the provider has registered byte for byte, so it cannot be derived from the request.
   - `INTEGRATION_ENC_KEY`: 32 random bytes, base64, encrypting integration tokens at rest. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Changing it makes existing connections unreadable and everyone has to reconnect.
   - `SYLLA_BASE_URL`, `SYLLA_CLIENT_ID`, `SYLLA_CLIENT_SECRET`: see Integrations below. Omit them and the Sylla integration simply shows as "Not configured"; nothing else is affected.
4. Deploy.

## Categories

A category is a name plus a default colour and icon, and it belongs to the
person: klndr ships none. Manage them under **Account & Settings ->
Categories**. Picking a category while writing a task hands over its colour and
icon; change either afterwards and your choice stands.

A task with no category is genuinely uncategorised - it keeps a plain colour,
gets no filter pill of its own, and lands in an "Uncategorized" column on the
board that only appears while something is in it.

Categories live in the settings document under `values.categories`
(`server/categories.js`), and tasks reference one by **name**, so a rename
cascades to every task server-side. Changing a category's colour asks first
before repainting the tasks already using it, and says how many there are.

**Migration.** A user who predates categories is migrated the first time
`/api/categories` is read: the list is derived from the categories their tasks
actually carry, and each one takes the colour and icon most of its own tasks
already wear. Categories that only ever existed as a menu entry - one you never
filed a task under - are not recreated. The absence of `values.categories` is
what marks a user as unmigrated, so an empty array means "migrated, and
deliberately empty" and is never re-derived.

Integrations resolve a source's subject name against this list: a name you
already have adopts that category's colour and icon, and a new one becomes a
category with a colour no other category has taken.

A connector sends a plain subject name, never a decorated one - Sylla keeps the
professor in its own field, so what arrives is "Physics", not
"Physics (Mourad)". The only exception is a name that would be ambiguous *for
you*: if two subjects on your own syllabus share a name, those two get the
professor spelled out so they do not collapse into one column. Anything the
source knows that klndr has no column for, the professor included, is kept
verbatim on the task under `metadata.source`.

## Integrations

Klndr can pull outstanding work from other apps into the tasks panel. Imported
work arrives **unscheduled**, so you drag it onto the week yourself, and
ticking it off updates the source app too.

The plumbing is provider-agnostic: `server/integrations/registry.js` maps a
provider id to a connector implementing the interface documented in
`server/integrations/connector.js`. Adding an integration is one new file plus
a registry entry. Nothing else in the codebase names a provider - tasks carry
generic `source_app` / `source_id` columns and the routes are
`/api/integrations/:provider/...`.

### Connecting Sylla

1. Sign in to Sylla, open **Sylla for developers** from the account menu, and register an app.
2. Set its redirect URI to `<KLNDR_BASE_URL>/api/integrations/sylla/callback`, matched exactly.
3. Tick the scopes `profile.read`, `sessions.read`, `progress.read`, `progress.write`.
4. Copy the client ID and secret (the secret is shown once) into `SYLLA_CLIENT_ID` and `SYLLA_CLIENT_SECRET`, and set `SYLLA_BASE_URL` to Sylla's origin.
5. Restart, then use **Account & Settings -> Integrations -> Connect**.

Running both locally means running them on different ports: Sylla defaults to
3000, so Klndr should use `PORT=3001`.

### Storage

Both local and Vercel use MongoDB (`server/db-mongodb.js`). Collections: `users`, `sessions`, `tasks`, `settings`, `announcements`, `integrations`. Indexes are created on connect; the default `yassen` / `password123` admin is seeded when the users collection is empty.

Configure MongoDB Atlas network access for your machine (local) and for Vercel. Change the seeded default password after first use.
