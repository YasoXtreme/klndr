# Klndr

## Run locally

1. Copy `.env` and fill in your MongoDB values (see comments in the file).
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
4. Deploy.

### Storage

Both local and Vercel use MongoDB (`server/db-mongodb.js`). Collections: `users`, `sessions`, `tasks`, `settings`. Indexes are created on connect; the default `yassen` / `password123` admin is seeded when the users collection is empty.

Configure MongoDB Atlas network access for your machine (local) and for Vercel. Change the seeded default password after first use.
