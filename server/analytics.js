const { collections } = require("./db");

// Read-only reporting. Lives outside db-mongodb.js because it is a large block
// of aggregation that nothing else calls, and because it is a different kind of
// code: every function here is a pure read, and none is part of the contract
// the app itself runs on.
//
// klndr has no self-signup - createUser is admin-only - so `users.created_at`
// is when an ADMIN PROVISIONED the account, which can precede first use by
// days. Anything cohort-shaped is therefore labelled "provisioned" rather than
// "signed up", and activation lag is reported on its own instead of being
// hidden inside a retention curve.

const TZ = process.env.ANALYTICS_TZ || "UTC";
const DAY = 86400;
const WEEK = 604800;

// Monday 5 January 1970 - the first Monday of the epoch, 1 January having been
// a Thursday. Bucketing by floor((ts - this) / WEEK) gives a stable week index
// with arithmetic alone, which avoids depending on $dateTrunc (MongoDB 5.0+).
// klndr states no server-version floor beyond what the driver needs, and a
// dashboard is a poor reason to introduce one.
const WEEK_EPOCH = 345600;

const nowSeconds = () => Math.floor(Date.now() / 1000);

const weekIndexExpr = (field) => ({
  $floor: { $divide: [{ $subtract: [field, WEEK_EPOCH] }, WEEK] },
});

const weekStartTs = (index) => index * WEEK + WEEK_EPOCH;
const weekLabel = (index) =>
  new Date(weekStartTs(index) * 1000).toISOString().slice(0, 10);

// Both heatmaps rebuild the instant from unix seconds and let Mongo do the
// timezone maths, because a fixed offset gets DST wrong for half the year.
const asDate = (secondsExpr) => ({
  $toDate: { $multiply: [secondsExpr, 1000] },
});

function utcDayTs(seconds) {
  const d = new Date(seconds * 1000);
  return Math.floor(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000,
  );
}

function clampDays(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 90;
  return Math.min(3650, Math.max(7, Math.floor(n)));
}

function fillWeeks(rows, fromTs, toTs) {
  const counts = new Map(rows.map((r) => [r._id, r.count]));
  const first = Math.floor((fromTs - WEEK_EPOCH) / WEEK);
  const last = Math.floor((toTs - WEEK_EPOCH) / WEEK);
  const out = [];
  for (let i = first; i <= last; i++) {
    out.push({ week: weekLabel(i), week_ts: weekStartTs(i), count: counts.get(i) || 0 });
  }
  return out;
}

// ==========================================
// COVERAGE
// ==========================================
//
// Nothing here is backfilled. tasks.updated_at is an UPPER BOUND on creation,
// so deriving created_at from it would drag every date forward and make the
// earliest weeks look empty - undetectably, and permanently. Reporting the hole
// instead keeps the totals reconcilable: total = charted + pre-instrumentation.
//
// instrumented_since is probed from the data rather than hardcoded, so it can
// never drift from reality and survives a redeploy.

async function earliest(collection, field) {
  const doc = await collection
    .find({ [field]: { $exists: true } })
    .sort({ [field]: 1 })
    .limit(1)
    .project({ [field]: 1 })
    .next();
  return doc ? doc[field] : null;
}

async function buildMeta(days) {
  const { users, tasks, activity } = await collections();
  const to = nowSeconds();
  const window = clampDays(days);
  const from = to - window * DAY;

  const [
    firstActivity,
    firstTaskCreated,
    firstTaskCompleted,
    firstLogin,
    usersTotal,
    usersWithLogin,
    tasksTotal,
    tasksWithCreated,
    tasksCompleted,
    tasksCompletedStamped,
  ] = await Promise.all([
    activity.find({}).sort({ day_ts: 1 }).limit(1).project({ day_ts: 1 }).next(),
    earliest(tasks, "created_at"),
    earliest(tasks, "completed_at"),
    earliest(users, "last_login_at"),
    users.countDocuments(),
    users.countDocuments({ login_count: { $exists: true } }),
    tasks.countDocuments(),
    tasks.countDocuments({ created_at: { $exists: true } }),
    tasks.countDocuments({ completed: true }),
    tasks.countDocuments({ completed: true, completed_at: { $exists: true } }),
  ]);

  return {
    generated_at: to,
    tz: TZ,
    range: { days: window, from_ts: from, to_ts: to },
    instrumented_since: {
      activity: firstActivity ? firstActivity.day_ts : null,
      task_created_at: firstTaskCreated,
      task_completed_at: firstTaskCompleted,
      // The earliest login ever OBSERVED, which is when instrumentation landed
      // - not when the account was first used.
      login: firstLogin,
    },
    coverage: {
      users_total: usersTotal,
      users_with_login_count: usersWithLogin,
      tasks_total: tasksTotal,
      tasks_with_created_at: tasksWithCreated,
      tasks_pre_instrumentation: tasksTotal - tasksWithCreated,
      tasks_completed_total: tasksCompleted,
      tasks_completed_with_completed_at: tasksCompletedStamped,
    },
  };
}

// ==========================================
// SHARED READS
// ==========================================

/**
 * Every activity row in a window, as plain objects.
 *
 * This is the one place bulk-reading a collection is correct, and the reason
 * matters: there is exactly one document per person per day, so the row count
 * IS the cardinality of the answer - bounded by (people x days), not by request
 * or task volume. A hundred people over a year is 36k tiny rows, and the
 * { day_ts, user_id } index covers the projection so no document is read off
 * disk. This is deliberately NOT the getTasks pattern, where rows per user are
 * unbounded.
 */
async function activityRows(fromTs, toTs, withPings = false) {
  const { activity } = await collections();
  const projection = { _id: 0, user_id: 1, day_ts: 1 };
  if (withPings) projection.pings = 1;
  const query = fromTs == null ? {} : { day_ts: { $gte: fromTs, $lte: toTs } };
  return activity.find(query, { projection }).toArray();
}

/**
 * The first INSTANT each person was seen, not the first day.
 *
 * Kept separate from activityRows on purpose. That query is covered by the
 * { day_ts, user_id } index and must stay that way, and first_at is not in the
 * key. This is also a correctness matter rather than a nicety: day_ts is UTC
 * midnight, so measuring activation as (first day - provisioned at) makes
 * anyone provisioned and active on the same day look like they started BEFORE
 * their account existed, and a negative lag gets thrown away as nonsense.
 */
async function firstActivityByUser() {
  const { activity } = await collections();
  const rows = await activity
    .aggregate([{ $group: { _id: "$user_id", first_at: { $min: "$first_at" } } }])
    .toArray();
  return new Map(rows.map((r) => [r._id, r.first_at]));
}

/** Live sessions grouped by person. Doubles as the fallback last-login source. */
async function sessionsByUser() {
  const { sessions } = await collections();
  const rows = await sessions
    .aggregate([
      { $match: { expires_at: { $gt: new Date() } } },
      {
        $group: {
          _id: "$user_id",
          live_sessions: { $sum: 1 },
          newest_login: { $max: "$created_at" },
        },
      },
    ])
    .toArray();
  return new Map(rows.map((r) => [r._id, r]));
}

/** Per-person task counters. One $group, one row per person. */
async function taskStatsByUser() {
  const { tasks } = await collections();
  const rows = await tasks
    .aggregate([
      {
        $group: {
          _id: "$user_id",
          total: { $sum: 1 },
          scheduled: {
            $sum: {
              $cond: [
                { $gt: [{ $size: { $ifNull: ["$start_times", []] } }, 0] },
                1,
                0,
              ],
            },
          },
          completed: { $sum: { $cond: ["$completed", 1, 0] } },
          imported: {
            $sum: { $cond: [{ $ifNull: ["$source_app", false] }, 1, 0] },
          },
          uncategorised: {
            $sum: {
              $cond: [
                { $in: [{ $ifNull: ["$category", null] }, [null, ""]] },
                1,
                0,
              ],
            },
          },
          planned_minutes: { $sum: { $ifNull: ["$total_duration", 0] } },
        },
      },
    ])
    .toArray();
  return new Map(rows.map((r) => [r._id, r]));
}

/**
 * Streaks, computed from activity rows already in memory.
 *
 * In JS rather than as a $setWindowFields gaps-and-islands pipeline: the rows
 * are fetched anyway for DAU, the logic is a dozen lines, and it keeps the
 * whole feature off MongoDB 5.0-only operators.
 */
function streaksByUser(rows, todayTs) {
  const byUser = new Map();
  for (const row of rows) {
    if (!byUser.has(row.user_id)) byUser.set(row.user_id, []);
    byUser.get(row.user_id).push(row.day_ts);
  }

  const out = new Map();
  for (const [userId, raw] of byUser) {
    const days = [...new Set(raw)].sort((a, b) => a - b);
    let longest = 0;
    let run = 0;
    let previous = null;
    for (const day of days) {
      run = previous !== null && day - previous === DAY ? run + 1 : 1;
      if (run > longest) longest = run;
      previous = day;
    }
    // Only a run still touching today or yesterday is alive; an older one
    // ended, however long it was.
    const last = days[days.length - 1];
    out.set(userId, {
      current_streak: last >= todayTs - DAY ? run : 0,
      longest_streak: longest,
      first_active_at: days[0],
      last_active_day: last,
      days_active: days.length,
    });
  }
  return out;
}

module.exports = {
  TZ,
  DAY,
  WEEK,
  WEEK_EPOCH,
  clampDays,
  nowSeconds,
  utcDayTs,
  weekIndexExpr,
  weekLabel,
  weekStartTs,
  fillWeeks,
  asDate,
  buildMeta,
  activityRows,
  firstActivityByUser,
  sessionsByUser,
  taskStatsByUser,
  streaksByUser,
};
