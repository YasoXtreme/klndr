const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { MongoClient } = require("mongodb");

const mongoUri = process.env.MONGODB_URI;
const databaseName = process.env.MONGODB_DB || "klndr";

if (!mongoUri) {
  throw new Error(
    "MONGODB_URI must be set (see .env for local development, or Vercel env vars in production)",
  );
}

let clientPromise;
let database;

async function getDatabase() {
  if (!clientPromise) {
    const client = new MongoClient(mongoUri);
    clientPromise = client.connect();
  }
  if (!database) {
    const client = await clientPromise;
    database = client.db(databaseName);
    await Promise.all([
      database
        .collection("users")
        .createIndex({ username: 1 }, { unique: true }),
      database
        .collection("sessions")
        .createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
      database.collection("tasks").createIndex({ user_id: 1 }),
      // Imported tasks are looked up by where they came from on every sync.
      // Sparse because every task predating integrations lacks these fields
      // and would otherwise pile up under the same (null, null) key.
      database
        .collection("tasks")
        .createIndex({ user_id: 1, source_app: 1, source_id: 1 }, { sparse: true }),
      database
        .collection("settings")
        .createIndex({ user_id: 1 }, { unique: true }),
      database
        .collection("announcements")
        .createIndex({ id: 1 }, { unique: true }),
      // Receipts are read one person at a time (their feed) and one post at a
      // time (its Studio stats), and neither is a prefix of the other.
      database
        .collection("announcement_receipts")
        .createIndex({ user_id: 1 }),
      database
        .collection("announcement_receipts")
        .createIndex({ announcement_id: 1 }),
      database.collection("media").createIndex({ id: 1 }, { unique: true }),
      database
        .collection("media")
        .createIndex({ status: 1, created_at: -1 }),
      // One connection per person per provider.
      database
        .collection("integrations")
        .createIndex({ user_id: 1, provider: 1 }, { unique: true }),
      // Analytics reads these two ways round and neither is a prefix of the
      // other: instance-wide over a date range, and one person over all time.
      // The first is a covered scan - the projection is exactly the key - so
      // DAU over a year never reads a document off disk.
      database
        .collection("activity_daily")
        .createIndex({ day_ts: 1, user_id: 1 }),
      database
        .collection("activity_daily")
        .createIndex({ user_id: 1, day_ts: 1 }),
      // Sparse for the same reason as the source_* index above: every task
      // written before these fields existed lacks them, and would otherwise
      // pile up under one null key. Sparseness is also what makes the
      // "when did instrumentation start" probe a one-document index hit.
      database.collection("tasks").createIndex({ created_at: 1 }, { sparse: true }),
      database
        .collection("tasks")
        .createIndex({ completed_at: 1 }, { sparse: true }),
    ]);
  }
  return database;
}

const ready = getDatabase().then(async (db) => {
  if ((await db.collection("users").countDocuments()) === 0) {
    const password_hash = bcrypt.hashSync("password123", 10);
    await db.collection("users").insertOne({
      id: "usr_" + crypto.randomBytes(6).toString("hex"),
      username: "yassen",
      password_hash,
      role: "admin",
      created_at: Math.floor(Date.now() / 1000),
    });
  }
});

async function collections() {
  await ready;
  const db = await getDatabase();
  return {
    users: db.collection("users"),
    sessions: db.collection("sessions"),
    tasks: db.collection("tasks"),
    settings: db.collection("settings"),
    announcements: db.collection("announcements"),
    receipts: db.collection("announcement_receipts"),
    counters: db.collection("counters"),
    media: db.collection("media"),
    integrations: db.collection("integrations"),
    activity: db.collection("activity_daily"),
  };
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

function withoutPassword(user) {
  if (!user) return null;
  const { _id, password_hash, ...safeUser } = user;
  return safeUser;
}

async function getUserByUsername(username) {
  const { users } = await collections();
  return users.findOne({ username: username.toLowerCase().trim() });
}

async function getUserById(id) {
  const { users } = await collections();
  return users.findOne({ id });
}

async function getAllUsers() {
  const { users } = await collections();
  return (await users.find({}).toArray()).map(withoutPassword);
}

async function createUser(username, password, role = "user") {
  const { users } = await collections();
  const cleanUsername = username.toLowerCase().trim();
  if (await users.findOne({ username: cleanUsername })) {
    throw new Error("User already exists");
  }

  const newUser = {
    id: "usr_" + crypto.randomBytes(6).toString("hex"),
    username: cleanUsername,
    password_hash: bcrypt.hashSync(password, 10),
    role,
    created_at: Math.floor(Date.now() / 1000),
  };
  try {
    await users.insertOne(newUser);
  } catch (error) {
    if (error.code === 11000) throw new Error("User already exists");
    throw error;
  }
  return withoutPassword(newUser);
}

async function changeUsername(userId, newUsername) {
  const { users } = await collections();
  const cleanUsername = newUsername.toLowerCase().trim();
  if (!cleanUsername) throw new Error("Username cannot be empty");
  if (await users.findOne({ username: cleanUsername, id: { $ne: userId } })) {
    throw new Error("Username is already taken");
  }
  const result = await users.findOneAndUpdate(
    { id: userId },
    { $set: { username: cleanUsername } },
    { returnDocument: "after" },
  );
  if (!result) throw new Error("User not found");
  return withoutPassword(result);
}

async function changePassword(userId, currentPassword, newPassword, keepToken) {
  const { users } = await collections();
  const user = await users.findOne({ id: userId });
  if (!user) throw new Error("User not found");
  if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
    throw new Error("Current password is incorrect");
  }
  if (!newPassword || newPassword.length < 4) {
    throw new Error("New password must be at least 4 characters");
  }
  await users.updateOne(
    { id: userId },
    {
      $set: { password_hash: bcrypt.hashSync(newPassword, 10) },
      // Clearing the flag is what releases an admin-reset user into the app.
      $unset: { must_change_password: "" },
    },
  );
  // Retiring the old password has to retire the sessions issued against it,
  // otherwise a stolen 30-day session outlives the password change entirely.
  await destroyUserSessions(userId, { keepToken });
  return true;
}

async function deleteUser(username) {
  const { users, sessions, tasks, settings, activity, receipts } = await collections();
  const user = await getUserByUsername(username);
  if (!user) return false;
  await Promise.all([
    users.deleteOne({ id: user.id }),
    sessions.deleteMany({ user_id: user.id }),
    tasks.deleteMany({ user_id: user.id }),
    settings.deleteOne({ user_id: user.id }),
    // The activity trail has to go with the account. Left behind it would be
    // both a record of someone who asked to be removed and a permanent orphan
    // in the analytics: an id with no user still counts toward active-account
    // numbers and never ages out, because this collection has no TTL.
    activity.deleteMany({ user_id: user.id }),
    // The same goes for what they read and reacted to: a reaction from a
    // deleted account would otherwise go on counting on a post forever.
    receipts.deleteMany({ user_id: user.id }),
  ]);
  return true;
}

// Ambiguous glyphs (0/O, 1/l/I, 8/B) are left out so a temporary password
// survives being read down a phone line or copied off a screen.
const TEMP_PASSWORD_ALPHABET =
  "abcdefghjkmnpqrstuvwxyz" + "23456789" + "ACDEFGHJKLMNPQRSTUVWXYZ";

function generateTempPassword(length = 12) {
  const alphabet = TEMP_PASSWORD_ALPHABET;
  // Rejection sampling: 256 is not a multiple of the alphabet length, so a
  // plain modulo would bias the result toward its first characters.
  const limit = 256 - (256 % alphabet.length);
  const chars = [];
  while (chars.length < length) {
    for (const byte of crypto.randomBytes(length)) {
      if (byte >= limit) continue;
      chars.push(alphabet[byte % alphabet.length]);
      if (chars.length >= length) break;
    }
  }
  // Grouped so it can be dictated without losing your place.
  return chars.join("").replace(/(.{4})(?=.)/g, "$1-");
}

// keepToken spares the caller's own session, so changing your own password
// does not log you out of the tab you changed it in.
async function destroyUserSessions(userId, { keepToken } = {}) {
  const { sessions } = await collections();
  const filter = { user_id: userId };
  if (keepToken) filter._id = { $ne: keepToken };
  await sessions.deleteMany(filter);
}

// The only account recovery path there is: no user document carries an email,
// so a reset link has nowhere to go and an admin has to hand this over
// out-of-band. Returns null when the username does not exist.
async function adminResetPassword(username) {
  const { users } = await collections();
  const user = await getUserByUsername(username);
  if (!user) return null;

  const tempPassword = generateTempPassword();
  await users.updateOne(
    { id: user.id },
    {
      $set: {
        password_hash: bcrypt.hashSync(tempPassword, 10),
        must_change_password: true,
      },
    },
  );
  // Every session goes, with no keepToken: a reset is usually prompted by a
  // lockout or a compromise, and the point is to evict whoever holds them.
  await destroyUserSessions(user.id);

  return {
    user: withoutPassword({ ...user, must_change_password: true }),
    tempPassword,
  };
}

function verifyPassword(user, password) {
  return bcrypt.compareSync(password, user.password_hash);
}

async function createSession(userId) {
  const { sessions } = await collections();
  const token = "ses_" + crypto.randomBytes(32).toString("hex");
  const now = Math.floor(Date.now() / 1000);
  await sessions.insertOne({
    _id: token,
    user_id: userId,
    created_at: now,
    expires_at: new Date((now + 30 * 24 * 60 * 60) * 1000),
  });
  return token;
}

async function validateSession(token) {
  if (!token) return null;
  const { sessions } = await collections();
  const session = await sessions.findOne({ _id: token });
  const expiresAt =
    session && session.expires_at instanceof Date
      ? Math.floor(session.expires_at.getTime() / 1000)
      : session && session.expires_at;
  if (!session || expiresAt < Math.floor(Date.now() / 1000)) {
    if (session) await sessions.deleteOne({ _id: token });
    return null;
  }
  return withoutPassword(await getUserById(session.user_id));
}

async function destroySession(token) {
  if (!token) return;
  const { sessions } = await collections();
  await sessions.deleteOne({ _id: token });
}

// ==========================================
// ACTIVITY
// ==========================================
//
// klndr recorded nothing about when anyone actually used it: users carried a
// created_at and tasks an updated_at, and that was the whole temporal surface.
// The sessions collection looks like login history but is not - rows are
// deleted on logout, on password change and on an admin reset - so "who is
// still showing up" had no honest answer.
//
// These three writes are that answer. They are deliberately the smallest thing
// that works, because they hang off the hot path.

/**
 * Claim this person's five-minute activity window.
 *
 * Compare-and-swap rather than read-then-write, in the same shape as
 * claimIntegrationRefresh: two requests arriving together both see the same
 * stale last_seen_at on their own req.user and would otherwise both count the
 * window. Exactly one caller wins the update, and only that one does the
 * rollup, which is what keeps `pings` meaning "distinct windows".
 */
async function claimActivityWindow(userId, now, cutoff) {
  const { users } = await collections();
  const result = await users.updateOne(
    {
      id: userId,
      $or: [
        { last_seen_at: { $exists: false } },
        { last_seen_at: { $lt: cutoff } },
      ],
    },
    { $set: { last_seen_at: now } },
  );
  return result.modifiedCount === 1;
}

/**
 * Fold one claimed window into the person's row for the day.
 *
 * Idempotent by construction: the _id IS the (day, person) pair, so a retry or
 * two racing containers converge on one document instead of needing a unique
 * index to catch them. The day comes first in the key because the query that
 * matters is a date range across everyone - "user:day" would sort by person and
 * leave that scan with no locality at all.
 */
async function recordActivityDay(userId, atSeconds) {
  const { activity } = await collections();
  const at = new Date(atSeconds * 1000);
  const dayKey = at.toISOString().slice(0, 10);
  const dayTs = Math.floor(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()) / 1000,
  );

  await activity.updateOne(
    { _id: `${dayKey}:${userId}` },
    {
      // Fixed for a given _id, so written exactly once.
      $setOnInsert: { user_id: userId, day_ts: dayTs },
      $min: { first_at: atSeconds },
      $max: { last_at: atSeconds },
      // `hours` is a subdocument of counters, not an array and not a bitmask.
      // $inc on a missing "hours.14" creates the object by itself, whereas
      // pre-seeding a 24-slot array with $setOnInsert collides with this very
      // $inc on the shared `hours` prefix and throws. Counts rather than
      // presence bits because a heatmap of presence makes every weekday
      // morning look identical.
      //
      // Invariant: sum(values(hours)) === pings. That is what lets a read
      // re-bucket a day into a different timezone.
      $inc: { pings: 1, [`hours.${at.getUTCHours()}`]: 1 },
    },
    { upsert: true },
  );
}

/**
 * Deliberately does not touch last_seen_at. Leaving it stale is what makes the
 * very next API call open the day's activity window, so a login always shows up
 * as activity without this function having to know how that works.
 */
async function recordLogin(userId) {
  const { users } = await collections();
  await users.updateOne(
    { id: userId },
    { $set: { last_login_at: nowSeconds() }, $inc: { login_count: 1 } },
  );
}

async function getTasks(userId, filter = {}) {
  const { tasks } = await collections();
  let userTasks = await tasks.find({ user_id: userId }).toArray();
  if (filter.startDate && filter.endDate) {
    const start = Number(filter.startDate);
    const end = Number(filter.endDate);
    userTasks = userTasks.filter((task) => {
      if (!task.start_times || task.start_times.length === 0) return true;
      return task.start_times.some((st, index) => {
        const segmentEnd = st + (task.durations[index] || 60) * 60;
        return st <= end && segmentEnd >= start;
      });
    });
  }
  return userTasks;
}

async function getTaskById(taskId, userId) {
  const { tasks } = await collections();
  return tasks.findOne({ id: taskId, user_id: userId });
}

// klndr shipped in 2026, so anything older than this is not a task that was
// really made then - it is a bad clock, a unit mix-up (milliseconds read as
// seconds lands in the year 56000), or someone trying it on.
const EARLIEST_PLAUSIBLE = Date.UTC(2025, 0, 1) / 1000;

function plausiblePast(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < EARLIEST_PLAUSIBLE || n > fallback) return fallback;
  return Math.floor(n);
}

/**
 * Stamp or clear completion timestamps for one write.
 *
 * The server owns these fields outright, and there are two separate reasons it
 * cannot simply keep what arrives.
 *
 * updateTask has no allowlist - it replaces the document with
 * { ...existing, ...updates } - so a client could post any completion time it
 * liked and the analytics page would report it as fact.
 *
 * And the client cannot carry a segment's stamp even in good faith:
 * TaskModel.ensureSegments rebuilds every segment as exactly
 * { id, start_time, duration, completed }, so a server-written completed_at is
 * stripped on read and comes back missing on the next drag - which a
 * replaceOne would then persist as gone.
 *
 * So the transition is recomputed here from what the database already knew,
 * matched by segment id, and anything inbound under these names is discarded.
 */
function applyCompletionTimestamps(existing, next, at = nowSeconds()) {
  const wasDone = Boolean(existing.completed);
  const isDone = Boolean(next.completed);

  delete next.completed_at;
  if (isDone && !wasDone) next.completed_at = at;
  else if (isDone && existing.completed_at) {
    next.completed_at = existing.completed_at;
  }

  if (Array.isArray(next.segments)) {
    const before = new Map(
      (existing.segments || []).map((seg) => [seg.id, seg]),
    );
    next.segments = next.segments.map((seg) => {
      const { completed_at: _inbound, ...clean } = seg;
      if (!clean.completed) return clean;
      const prior = before.get(clean.id);
      // A segment id the server has never seen, arriving already ticked, is a
      // split of a block that was finished earlier. There is no honest moment
      // to stamp it with, so it goes without one rather than claiming it was
      // finished just now and inventing a spike on today's chart.
      if (!prior) return clean;
      if (!prior.completed) return { ...clean, completed_at: at };
      return prior.completed_at
        ? { ...clean, completed_at: prior.completed_at }
        : clean;
    });
  }

  return next;
}

async function createTask(userId, taskData) {
  const { tasks } = await collections();
  const newTask = {
    id: taskData.id || "tsk_" + crypto.randomBytes(6).toString("hex"),
    user_id: userId,
    title: taskData.title || "Untitled Task",
    start_times: Array.isArray(taskData.start_times)
      ? taskData.start_times
      : [],
    durations: Array.isArray(taskData.durations) ? taskData.durations : [],
    // Calendar blocks. Kept alongside start_times/durations, which stay derived
    // so the date-range query above still works on both old and new records.
    segments: Array.isArray(taskData.segments) ? taskData.segments : [],
    total_duration: Number(
      taskData.total_duration || taskData.default_timing || 60,
    ),
    is_locked:
      taskData.is_locked !== undefined ? Boolean(taskData.is_locked) : true,
    default_timing: Number(taskData.default_timing || 60),
    color: taskData.color || "#3ba4f6",
    icon: taskData.icon || "task_alt",
    // No category is a real state, not a hole to plug: klndr ships none, so
    // there is nothing to default to.
    category: taskData.category || null,
    completed: Boolean(taskData.completed),
    metadata: taskData.metadata || {},
    // Where this task came from, when it was not made here. Deliberately
    // generic: `source_app` is a provider id, not a hardcoded name, so a
    // second integration needs no schema change.
    //
    // These MUST be listed here. This object is an allowlist - anything not
    // named is dropped - and every create path goes through it, including
    // undoing a delete (app.js replays the snapshot through API.createTask).
    // Leaving them out would silently sever an undone task from its source,
    // and the next sync would import a duplicate.
    source_app: taskData.source_app || null,
    source_id: taskData.source_id || null,
    source_url: taskData.source_url || null,
    source_revision: taskData.source_revision || null,
    // What the source last said about completion, so the next sync can tell
    // which side changed rather than guessing.
    source_completed: Boolean(taskData.source_completed),
    // Undoing a delete replays the whole snapshot through here, and
    // KlndrApp.mergeTask is a plain Object.assign, so the original creation
    // time really does come back. A plausible past value is honoured so an undo
    // does not re-date the work; anything else is discarded, because this is a
    // field the analytics page treats as fact and the client is the one thing
    // that can lie about it.
    created_at: plausiblePast(taskData.created_at, nowSeconds()),
    updated_at: Math.floor(Date.now() / 1000),
  };
  // A task can be created already ticked - an undone delete, or an import of
  // something the source considers done.
  if (newTask.completed) {
    newTask.completed_at = plausiblePast(taskData.completed_at, nowSeconds());
  }
  await tasks.insertOne(newTask);

  // Recreating an imported task clears its tombstone. Undo goes through here,
  // so without this an undone delete would leave the task on screen while the
  // integration still considered it dismissed.
  if (newTask.source_app && newTask.source_id) {
    await undismissSourceItem(userId, newTask.source_app, newTask.source_id);
  }

  return newTask;
}

async function updateTask(userId, taskId, updates) {
  const { tasks } = await collections();
  const existing = await getTaskById(taskId, userId);
  if (!existing) throw new Error("Task not found");
  const updatedTask = {
    ...existing,
    ...updates,
    id: existing.id,
    user_id: existing.user_id,
    updated_at: Math.floor(Date.now() / 1000),
  };
  if (updates.total_duration !== undefined)
    updatedTask.total_duration = Number(updates.total_duration);
  if (updates.is_locked !== undefined)
    updatedTask.is_locked = Boolean(updates.is_locked);
  if (updates.completed !== undefined)
    updatedTask.completed = Boolean(updates.completed);
  // created_at is written once, by createTask, and is never an input here.
  delete updatedTask.created_at;
  if (existing.created_at) updatedTask.created_at = existing.created_at;
  applyCompletionTimestamps(existing, updatedTask);
  delete updatedTask._id;
  await tasks.replaceOne({ id: taskId, user_id: userId }, updatedTask);
  return updatedTask;
}

async function batchUpdateTasks(userId, taskUpdatesList) {
  const { tasks } = await collections();
  const updatedResults = [];
  for (const item of taskUpdatesList) {
    const existing = await getTaskById(item.id, userId);
    if (!existing) continue;
    const updatedTask = {
      ...existing,
      ...item,
      id: existing.id,
      user_id: userId,
      updated_at: Math.floor(Date.now() / 1000),
    };
    delete updatedTask.created_at;
    if (existing.created_at) updatedTask.created_at = existing.created_at;
    applyCompletionTimestamps(existing, updatedTask);
    delete updatedTask._id;
    await tasks.replaceOne({ id: item.id, user_id: userId }, updatedTask);
    updatedResults.push(updatedTask);
  }
  return updatedResults;
}

async function deleteTask(userId, taskId) {
  const { tasks } = await collections();

  // An imported task has to leave a tombstone on the way out. There is no soft
  // delete here, so without one the next sync would see the source item, find
  // no matching task, and import it straight back - which reads as the delete
  // button being broken.
  const existing = await tasks.findOne({ id: taskId, user_id: userId });
  if (existing && existing.source_app && existing.source_id) {
    await dismissSourceItem(userId, existing.source_app, existing.source_id);
  }

  const result = await tasks.deleteOne({ id: taskId, user_id: userId });
  return result.deletedCount === 1;
}

// Every task this person has imported from one provider, keyed by source id.
async function getTasksBySource(userId, provider) {
  const { tasks } = await collections();
  return tasks.find({ user_id: userId, source_app: provider }).toArray();
}

// ==========================================
// INTEGRATIONS
// ==========================================

async function getIntegration(userId, provider) {
  const { integrations } = await collections();
  return integrations.findOne({ user_id: userId, provider });
}

async function listIntegrations(userId) {
  const { integrations } = await collections();
  return integrations.find({ user_id: userId }).toArray();
}

async function upsertIntegration(userId, provider, values) {
  const { integrations } = await collections();
  await integrations.updateOne(
    { user_id: userId, provider },
    {
      $set: { user_id: userId, provider, ...values },
      $setOnInsert: { connected_at: Math.floor(Date.now() / 1000), dismissed_ids: [] },
    },
    { upsert: true },
  );
  return getIntegration(userId, provider);
}

async function updateIntegration(userId, provider, values) {
  const { integrations } = await collections();
  await integrations.updateOne(
    { user_id: userId, provider },
    { $set: values },
  );
  return getIntegration(userId, provider);
}

async function deleteIntegration(userId, provider) {
  const { integrations } = await collections();
  const result = await integrations.deleteOne({ user_id: userId, provider });
  return result.deletedCount === 1;
}

/**
 * Claims the right to refresh this connection's tokens.
 *
 * Compare-and-swap on the refresh token we saw, plus a short lease. On Vercel
 * two concurrent invocations can both find the access token expired; without
 * this they would both spend the same rotating refresh token, and the second
 * one to arrive would be treated as a replay. Exactly one caller wins here and
 * the other waits for the result.
 *
 * The lease is short and is always released, because a serverless invocation
 * can be killed mid-flight and a lease that only ever expired by timeout would
 * strand the connection.
 */
async function claimIntegrationRefresh(userId, provider, seenRefreshToken, leaseSeconds) {
  const { integrations } = await collections();
  const now = Math.floor(Date.now() / 1000);
  const result = await integrations.findOneAndUpdate(
    {
      user_id: userId,
      provider,
      refresh_token: seenRefreshToken,
      $or: [
        { refresh_lock_until: { $exists: false } },
        { refresh_lock_until: null },
        { refresh_lock_until: { $lt: now } },
      ],
    },
    { $set: { refresh_lock_until: now + leaseSeconds } },
    { returnDocument: "after" },
  );
  return result || null;
}

async function releaseIntegrationRefresh(userId, provider, values = {}) {
  const { integrations } = await collections();
  await integrations.updateOne(
    { user_id: userId, provider },
    { $set: values, $unset: { refresh_lock_until: "" } },
  );
}

async function dismissSourceItem(userId, provider, sourceId) {
  const { integrations } = await collections();
  await integrations.updateOne(
    { user_id: userId, provider },
    { $addToSet: { dismissed_ids: sourceId } },
  );
}

async function undismissSourceItem(userId, provider, sourceId) {
  const { integrations } = await collections();
  await integrations.updateOne(
    { user_id: userId, provider },
    { $pull: { dismissed_ids: sourceId } },
  );
}

async function clearDismissedSourceItems(userId, provider) {
  const { integrations } = await collections();
  await integrations.updateOne(
    { user_id: userId, provider },
    { $set: { dismissed_ids: [] } },
  );
}

async function getSettings(userId) {
  const { settings } = await collections();
  const document = await settings.findOne({ user_id: userId });
  return document
    ? document.values
    : {
        bucketHours: 2,
        snapToRuler: false,
        tickPercent: 25,
        theme: "default",
      };
}

async function updateSettings(userId, newSettings) {
  const { settings } = await collections();
  const existing = await settings.findOne({ user_id: userId });
  const values = { ...(existing ? existing.values : {}), ...newSettings };
  await settings.updateOne(
    { user_id: userId },
    { $set: { user_id: userId, values } },
    { upsert: true },
  );
  return values;
}

// ==========================================
// CATEGORIES
// ==========================================
//
// A category list lives in the settings document, under `values.categories`.
// The absence of that key is load-bearing: it means "this user has never been
// migrated", and server/categories.js reads it to decide whether to derive a
// list from the categories their tasks already carry. An empty array means the
// opposite - migrated, and they deliberately have none - so the two must never
// be conflated, and `categories` must stay OUT of the getSettings defaults.

/**
 * Write the first category list a user ever gets, and only the first.
 *
 * Compare-and-set rather than a plain write, because two callers can reach the
 * migration at once: the client asks for its categories on boot, and the
 * background integration sync starts moments later and ensures the categories
 * its subjects need. Both would read "undefined" and both would write a whole
 * array, and the loser's work would vanish without a trace. Whoever gets there
 * second matches nothing, writes nothing, and reads back the winner's list.
 */
async function initCategoriesIfAbsent(userId, list) {
  const { settings } = await collections();
  await settings.updateOne(
    { user_id: userId, "values.categories": { $exists: false } },
    { $set: { user_id: userId, "values.categories": list } },
    { upsert: true },
  );
  const document = await settings.findOne({ user_id: userId });
  return (document && document.values && document.values.categories) || [];
}

// A rename cascades to every task carrying the old name, in one write. The
// client only holds the current week plus everything unscheduled, so it cannot
// do this itself without leaving older tasks pointing at a name that is gone.
async function retagTasksByCategory(userId, fromName, toName) {
  const { tasks } = await collections();
  const result = await tasks.updateMany(
    { user_id: userId, category: fromName },
    { $set: { category: toName, updated_at: Math.floor(Date.now() / 1000) } },
  );
  return result.modifiedCount;
}

// Push a category's new defaults onto the tasks already wearing it. Same reason
// as above: this has to reach tasks this client has never seen.
async function recolourTasksByCategory(userId, name, { color, icon }) {
  const { tasks } = await collections();
  const fields = { updated_at: Math.floor(Date.now() / 1000) };
  if (color) fields.color = color;
  if (icon) fields.icon = icon;
  const result = await tasks.updateMany(
    { user_id: userId, category: name },
    { $set: fields },
  );
  return result.modifiedCount;
}

// { categoryName: taskCount }, over ALL of a user's tasks. The count shown
// before a destructive apply has to be the true one, not the one visible in the
// week that happens to be on screen.
async function countTasksByCategory(userId) {
  const { tasks } = await collections();
  const rows = await tasks
    .aggregate([
      { $match: { user_id: userId, category: { $nin: [null, ""] } } },
      { $group: { _id: "$category", count: { $sum: 1 } } },
    ])
    .toArray();
  return Object.fromEntries(rows.map((row) => [row._id, row.count]));
}

// ==========================================
// ANNOUNCEMENTS
// ==========================================
//
// Storage only. What an announcement means - who it is for, when it counts as
// read, how a post from before the rewrite is interpreted - lives in
// server/announcements and protected/js/announcements/rules.js.

/**
 * The next announcement id.
 *
 * Ids stay numbers, because the legacy watermark compares them (see
 * Rules.isRead). They come from a counter rather than max + 1: two admins
 * creating at once would otherwise read the same max, and one insert would fail
 * on the unique index. The counter is seeded from the highest existing id the
 * first time it is needed, so it carries on from the posts already there.
 */
async function nextAnnouncementId() {
  const { announcements, counters } = await collections();
  if (!(await counters.findOne({ _id: "announcements" }))) {
    const last = await announcements
      .find({}, { projection: { _id: 0, id: 1 } })
      .sort({ id: -1 })
      .limit(1)
      .next();
    try {
      await counters.insertOne({ _id: "announcements", seq: last ? last.id : 0 });
    } catch (err) {
      // Somebody else seeded it first, which is the same outcome.
      if (err.code !== 11000) throw err;
    }
  }
  const counter = await counters.findOneAndUpdate(
    { _id: "announcements" },
    { $inc: { seq: 1 } },
    { returnDocument: "after" },
  );
  return counter.seq;
}

async function insertAnnouncement(doc) {
  const { announcements } = await collections();
  // A copy, because insertOne writes _id back onto the object it is handed.
  await announcements.insertOne({ ...doc });
}

async function getAnnouncement(id) {
  const { announcements } = await collections();
  return announcements.findOne({ id }, { projection: { _id: 0 } });
}

// Posts from before the rewrite carry no status and are published by definition
// (see model.normalize), so "published" has to include them.
async function listAnnouncements({ publishedOnly = false } = {}) {
  const { announcements } = await collections();
  const filter = publishedOnly
    ? { $or: [{ status: "published" }, { status: { $exists: false } }] }
    : {};
  return announcements
    .find(filter, { projection: { _id: 0 } })
    .sort({ id: -1 })
    .toArray();
}

/**
 * Apply a change only if nobody has changed the post since `revision`, and
 * return the result - or null when somebody has. A post from before revisions
 * existed counts as revision 1.
 */
async function updateAnnouncementIfRevision(id, revision, { set = {}, unset = {} }) {
  const { announcements } = await collections();
  const matches = [{ revision }];
  if (revision === 1) matches.push({ revision: { $exists: false } });
  const update = { $set: set, $inc: { revision: 1 } };
  if (Object.keys(unset).length) update.$unset = unset;
  return announcements.findOneAndUpdate({ id, $or: matches }, update, {
    returnDocument: "after",
    projection: { _id: 0 },
  });
}

async function deleteAnnouncement(id) {
  const { announcements, receipts } = await collections();
  const result = await announcements.deleteOne({ id });
  // A receipt only means anything next to the post it is about.
  await receipts.deleteMany({ announcement_id: id });
  return result.deletedCount === 1;
}

// ==========================================
// ANNOUNCEMENT RECEIPTS
// ==========================================
//
// One document per person per post, keyed "<announcement_id>:<user_id>", so a
// retry or two racing tabs converge on one row instead of needing an index to
// catch them - the same shape recordActivityDay uses.
//
// Timestamps belong to a delivery version. "Notify again" bumps a post's
// version, and the next event starts that person's receipt over, keeping only
// their reaction: nobody should have to react twice to one post.

const RECEIPT_STAMPS = {
  delivered: ["delivered_at"],
  opened: ["delivered_at", "opened_at"],
  dismissed: ["delivered_at", "dismissed_at"],
  cta: ["delivered_at", "opened_at", "cta_at"],
};
const VERSIONED_STAMPS = ["delivered_at", "opened_at", "dismissed_at", "cta_at"];

function receiptId(announcementId, userId) {
  return `${announcementId}:${userId}`;
}

async function recordReceiptEvent(announcementId, userId, version, event, at, retried = false) {
  const { receipts } = await collections();
  const _id = receiptId(announcementId, userId);
  const fields = RECEIPT_STAMPS[event];
  const stamps = Object.fromEntries(fields.map((field) => [field, at]));

  // The usual case: this delivery already has a receipt, and $min keeps the
  // first moment each thing happened.
  const kept = await receipts.updateOne({ _id, version: { $gte: version } }, { $min: stamps });
  if (kept.matchedCount) return;

  // No receipt yet, or only one from an earlier delivery: start this one over.
  const stale = VERSIONED_STAMPS.filter((field) => !fields.includes(field));
  try {
    await receipts.updateOne(
      { _id, $or: [{ version: { $lt: version } }, { version: { $exists: false } }] },
      {
        $set: { announcement_id: announcementId, user_id: userId, version, ...stamps },
        $unset: Object.fromEntries(stale.map((field) => [field, ""])),
      },
      { upsert: true },
    );
  } catch (err) {
    // Another request wrote this delivery's receipt between the two updates.
    // One more pass lands in the $min branch above.
    if (err.code === 11000 && !retried) {
      return recordReceiptEvent(announcementId, userId, version, event, at, true);
    }
    throw err;
  }
}

async function setReaction(announcementId, userId, reaction, at) {
  const { receipts } = await collections();
  const _id = receiptId(announcementId, userId);
  if (!reaction) {
    await receipts.updateOne({ _id }, { $unset: { reaction: "", reacted_at: "" } });
    return;
  }
  try {
    await receipts.updateOne(
      { _id },
      { $set: { announcement_id: announcementId, user_id: userId, reaction, reacted_at: at } },
      { upsert: true },
    );
  } catch (err) {
    if (err.code !== 11000) throw err;
    await receipts.updateOne({ _id }, { $set: { reaction, reacted_at: at } });
  }
}

async function getReceipt(announcementId, userId) {
  const { receipts } = await collections();
  return receipts.findOne(
    { _id: receiptId(announcementId, userId) },
    { projection: { _id: 0 } },
  );
}

async function getReceiptsForUser(userId) {
  const { receipts } = await collections();
  return receipts.find({ user_id: userId }, { projection: { _id: 0 } }).toArray();
}

async function getReceiptsForAnnouncement(announcementId) {
  const { receipts } = await collections();
  return receipts
    .find({ announcement_id: announcementId }, { projection: { _id: 0 } })
    .toArray();
}

// Every receipt, cut down to what the Studio's list view summarises.
async function listReceiptSummaries() {
  const { receipts } = await collections();
  return receipts
    .find(
      {},
      {
        projection: {
          _id: 0,
          announcement_id: 1,
          user_id: 1,
          version: 1,
          delivered_at: 1,
          opened_at: 1,
          cta_at: 1,
          reaction: 1,
        },
      },
    )
    .toArray();
}

/** Map of announcement id -> { reactionId: count }. */
async function reactionCounts(announcementIds) {
  if (!announcementIds.length) return new Map();
  const { receipts } = await collections();
  const rows = await receipts
    .aggregate([
      {
        $match: {
          announcement_id: { $in: announcementIds },
          reaction: { $type: "string" },
        },
      },
      {
        $group: {
          _id: { announcement: "$announcement_id", reaction: "$reaction" },
          count: { $sum: 1 },
        },
      },
    ])
    .toArray();

  const counts = new Map();
  for (const row of rows) {
    const id = row._id.announcement;
    if (!counts.has(id)) counts.set(id, {});
    counts.get(id)[row._id.reaction] = row.count;
  }
  return counts;
}

/**
 * When receipts started being written, probed from the data rather than
 * hardcoded - the analytics convention. Reach for posts older than this leans
 * on the legacy watermark, and the Studio says so.
 */
async function earliestReceiptAt() {
  const { receipts } = await collections();
  const first = await receipts
    .find({ delivered_at: { $exists: true } }, { projection: { _id: 0, delivered_at: 1 } })
    .sort({ delivered_at: 1 })
    .limit(1)
    .next();
  return first ? first.delivered_at : null;
}

// ==========================================
// MEDIA
// ==========================================
//
// The media library's rows. What may be uploaded, and the bucket itself, are
// server/media.js and server/storage/r2.js.

async function insertMedia(doc) {
  const { media } = await collections();
  await media.insertOne({ ...doc });
}

async function getMedia(id) {
  const { media } = await collections();
  return media.findOne({ id }, { projection: { _id: 0 } });
}

async function getMediaByIds(ids) {
  const { media } = await collections();
  return media.find({ id: { $in: ids } }, { projection: { _id: 0 } }).toArray();
}

async function listMedia({ status, createdBefore } = {}) {
  const { media } = await collections();
  const filter = {};
  if (status) filter.status = status;
  if (createdBefore) filter.created_at = { $lt: createdBefore };
  return media
    .find(filter, { projection: { _id: 0 } })
    .sort({ created_at: -1 })
    .toArray();
}

async function updateMedia(id, set) {
  const { media } = await collections();
  return media.findOneAndUpdate(
    { id },
    { $set: set },
    { returnDocument: "after", projection: { _id: 0 } },
  );
}

async function deleteMedia(id) {
  const { media } = await collections();
  const result = await media.deleteOne({ id });
  return result.deletedCount === 1;
}

/** Map of media id -> [{ id, title }] of every announcement using that file. */
async function mediaUsage() {
  const { announcements } = await collections();
  const rows = await announcements
    .find(
      { "media_refs.0": { $exists: true } },
      { projection: { _id: 0, id: 1, title: 1, media_refs: 1 } },
    )
    .toArray();
  const usage = new Map();
  for (const row of rows) {
    for (const mediaId of row.media_refs) {
      if (!usage.has(mediaId)) usage.set(mediaId, []);
      usage.get(mediaId).push({ id: row.id, title: row.title });
    }
  }
  return usage;
}



module.exports = {
  ready,
  // Exported so read-only reporting can run its own aggregations rather than
  // growing a CRUD wrapper per chart. Writes still go through the functions
  // below; nothing outside this file should be calling insert or update on a
  // handle it got from here.
  collections,
  getUserByUsername,
  getUserById,
  getAllUsers,
  createUser,
  deleteUser,
  changeUsername,
  changePassword,
  adminResetPassword,
  destroyUserSessions,
  verifyPassword,
  createSession,
  validateSession,
  destroySession,
  claimActivityWindow,
  recordActivityDay,
  recordLogin,
  getTasks,
  getTaskById,
  createTask,
  updateTask,
  batchUpdateTasks,
  deleteTask,
  getTasksBySource,
  getIntegration,
  listIntegrations,
  upsertIntegration,
  updateIntegration,
  deleteIntegration,
  claimIntegrationRefresh,
  releaseIntegrationRefresh,
  dismissSourceItem,
  undismissSourceItem,
  clearDismissedSourceItems,
  getSettings,
  updateSettings,
  initCategoriesIfAbsent,
  retagTasksByCategory,
  recolourTasksByCategory,
  countTasksByCategory,
  nextAnnouncementId,
  insertAnnouncement,
  getAnnouncement,
  listAnnouncements,
  updateAnnouncementIfRevision,
  deleteAnnouncement,
  recordReceiptEvent,
  setReaction,
  getReceipt,
  getReceiptsForUser,
  getReceiptsForAnnouncement,
  listReceiptSummaries,
  reactionCounts,
  earliestReceiptAt,
  insertMedia,
  getMedia,
  getMediaByIds,
  listMedia,
  updateMedia,
  deleteMedia,
  mediaUsage,
};
