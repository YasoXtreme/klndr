const express = require("express");
const reports = require("../analytics-reports");
const { clampDays } = require("../analytics");

// Thin handlers. Every guard is on the mount in server.js, because unlike the
// integrations router there are no navigations here - all five routes are
// admin-only JSON.

const router = express.Router();

// A warm serverless container answers a repeated request from here rather than
// re-running six aggregations. Deliberately short: this is a dashboard someone
// refreshes, not a cache anything depends on for correctness.
const TTL_MS = 60 * 1000;
const memo = new Map();

async function cached(key, build) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = await build();
  memo.set(key, { at: Date.now(), value });
  return value;
}

function handler(name, build) {
  return async (req, res) => {
    const days = clampDays(req.query.days);
    try {
      const payload = await cached(`${name}:${days}`, () => build(days));
      // These are numbers about identifiable people. They may sit in memory on
      // this instance for a minute, but nothing downstream gets to keep them.
      res.set("Cache-Control", "private, no-store");
      res.json(payload);
    } catch (err) {
      console.error(`analytics/${name} failed:`, err);
      res.status(500).json({ error: "Could not build this report" });
    }
  };
}

router.get("/overview", handler("overview", reports.overview));
router.get("/users", handler("users", reports.people));
router.get("/engagement", handler("engagement", reports.engagement));
router.get("/tasks", handler("tasks", reports.taskReport));
router.get("/system", handler("system", reports.system));

module.exports = router;
