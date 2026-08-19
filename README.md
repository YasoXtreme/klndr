# Klndr

## Run locally

```bash
npm install
npm start
```

Open <http://localhost:3000/login>.

## Deploy to Vercel

1. Import this repository into Vercel.
2. Leave the framework preset as **Other** and keep the build and output settings empty.
3. Add these production environment variables:
   - `MONGODB_URI`: your MongoDB Atlas connection string.
   - `MONGODB_DB`: the database name, for example `klndr`.
   - `SESSION_SECRET`: a long random value. Use the same value for every production deployment.
4. Deploy. When Vercel sets `VERCEL`, the app uses MongoDB through `server/db-mongodb.js`.

### Storage requirement

Local development stores users, sessions, tasks, and settings in `data/klndr.json`. On Vercel, the MongoDB adapter stores these in the `users`, `sessions`, `tasks`, and `settings` collections. The MongoDB adapter also creates the required indexes and seeds the default `yassen` admin account when the users collection is empty.

Configure MongoDB Atlas network access to allow Vercel connections. Change the seeded default password immediately after the first deployment.
