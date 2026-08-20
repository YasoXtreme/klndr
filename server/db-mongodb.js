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
      database
        .collection("settings")
        .createIndex({ user_id: 1 }, { unique: true }),
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
  };
}

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

async function changePassword(userId, currentPassword, newPassword) {
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
    { $set: { password_hash: bcrypt.hashSync(newPassword, 10) } },
  );
  return true;
}

async function deleteUser(username) {
  const { users, sessions, tasks, settings } = await collections();
  const user = await getUserByUsername(username);
  if (!user) return false;
  await Promise.all([
    users.deleteOne({ id: user.id }),
    sessions.deleteMany({ user_id: user.id }),
    tasks.deleteMany({ user_id: user.id }),
    settings.deleteOne({ user_id: user.id }),
  ]);
  return true;
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
    total_duration: Number(
      taskData.total_duration || taskData.default_timing || 60,
    ),
    is_locked:
      taskData.is_locked !== undefined ? Boolean(taskData.is_locked) : true,
    default_timing: Number(taskData.default_timing || 60),
    color: taskData.color || "#3ba4f6",
    icon: taskData.icon || "task_alt",
    category: taskData.category || "General",
    completed: Boolean(taskData.completed),
    metadata: taskData.metadata || {},
    updated_at: Math.floor(Date.now() / 1000),
  };
  await tasks.insertOne(newTask);
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
    delete updatedTask._id;
    await tasks.replaceOne({ id: item.id, user_id: userId }, updatedTask);
    updatedResults.push(updatedTask);
  }
  return updatedResults;
}

async function deleteTask(userId, taskId) {
  const { tasks } = await collections();
  const result = await tasks.deleteOne({ id: taskId, user_id: userId });
  return result.deletedCount === 1;
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

module.exports = {
  ready,
  getUserByUsername,
  getUserById,
  getAllUsers,
  createUser,
  deleteUser,
  changeUsername,
  changePassword,
  verifyPassword,
  createSession,
  validateSession,
  destroySession,
  getTasks,
  getTaskById,
  createTask,
  updateTask,
  batchUpdateTasks,
  deleteTask,
  getSettings,
  updateSettings,
};
