require("dotenv").config();

// Always use MongoDB (local + Vercel). Set MONGODB_DB to isolate environments
// (e.g. klndr_dev locally, klndr in production).
module.exports = require("./db-mongodb");
