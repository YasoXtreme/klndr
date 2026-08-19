const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");

const DATA_DIR = path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "klndr.json");

if (!process.env.VERCEL && !fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    const initialData = {
      users: [],
      sessions: {},
      tasks: [],
      settings: {},
    };
    saveDB(initialData);
    return initialData;
  }
  try {
    const raw = fs.readFileSync(DB_FILE, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.error("Error reading DB, re-initializing:", err);
    const initialData = { users: [], sessions: {}, tasks: [], settings: {} };
    saveDB(initialData);
    return initialData;
  }
}

function saveDB(data) {
  const tmpFile = DB_FILE + ".tmp";
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmpFile, DB_FILE);
}

// User operations
function getUserByUsername(username) {
  const db = loadDB();
  return db.users.find(
    (u) => u.username.toLowerCase() === username.toLowerCase().trim(),
  );
}

function getUserById(id) {
  const db = loadDB();
  return db.users.find((u) => u.id === id);
}

function getAllUsers() {
  const db = loadDB();
  return db.users.map(({ password_hash, ...u }) => u);
}

function createUser(username, password, role = "user") {
  const db = loadDB();
  const cleanUsername = username.toLowerCase().trim();
  if (db.users.some((u) => u.username.toLowerCase() === cleanUsername)) {
    throw new Error("User already exists");
  }

  const salt = bcrypt.genSaltSync(10);
  const password_hash = bcrypt.hashSync(password, salt);

  const newUser = {
    id: "usr_" + crypto.randomBytes(6).toString("hex"),
    username: cleanUsername,
    password_hash,
    role,
    created_at: Math.floor(Date.now() / 1000),
  };

  db.users.push(newUser);
  saveDB(db);
  const { password_hash: _, ...userWithoutPass } = newUser;
  return userWithoutPass;
}

function changeUsername(userId, newUsername) {
  const db = loadDB();
  const cleanUsername = newUsername.toLowerCase().trim();
  if (!cleanUsername) throw new Error("Username cannot be empty");

  if (
    db.users.some(
      (u) => u.id !== userId && u.username.toLowerCase() === cleanUsername,
    )
  ) {
    throw new Error("Username is already taken");
  }

  const user = db.users.find((u) => u.id === userId);
  if (!user) throw new Error("User not found");

  user.username = cleanUsername;
  saveDB(db);
  const { password_hash: _, ...safeUser } = user;
  return safeUser;
}

function changePassword(userId, currentPassword, newPassword) {
  const db = loadDB();
  const user = db.users.find((u) => u.id === userId);
  if (!user) throw new Error("User not found");

  if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
    throw new Error("Current password is incorrect");
  }

  if (!newPassword || newPassword.length < 4) {
    throw new Error("New password must be at least 4 characters");
  }

  const salt = bcrypt.genSaltSync(10);
  user.password_hash = bcrypt.hashSync(newPassword, salt);
  saveDB(db);
  return true;
}

function deleteUser(username) {
  const db = loadDB();
  const cleanUsername = username.toLowerCase().trim();
  const userObj = getUserByUsername(cleanUsername);
  if (!userObj) {
    return false;
  }
  db.users = db.users.filter((u) => u.id !== userObj.id);
  db.tasks = db.tasks.filter((t) => t.user_id !== userObj.id);
  for (const token in db.sessions) {
    if (db.sessions[token].user_id === userObj.id) {
      delete db.sessions[token];
    }
  }
  saveDB(db);
  return true;
}

function verifyPassword(user, password) {
  return bcrypt.compareSync(password, user.password_hash);
}

// Session operations
function createSession(userId) {
  const db = loadDB();
  const token = "ses_" + crypto.randomBytes(32).toString("hex");
  const expires_at = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60; // 30 days
  db.sessions[token] = {
    user_id: userId,
    created_at: Math.floor(Date.now() / 1000),
    expires_at,
  };
  saveDB(db);
  return token;
}

function validateSession(token) {
  if (!token) return null;
  const db = loadDB();
  const session = db.sessions[token];
  if (!session) return null;

  if (session.expires_at < Math.floor(Date.now() / 1000)) {
    delete db.sessions[token];
    saveDB(db);
    return null;
  }

  const user = db.users.find((u) => u.id === session.user_id);
  if (!user) return null;

  const { password_hash, ...safeUser } = user;
  return safeUser;
}

function destroySession(token) {
  if (!token) return;
  const db = loadDB();
  delete db.sessions[token];
  saveDB(db);
}

// Task operations
function getTasks(userId, filter = {}) {
  const db = loadDB();
  let userTasks = db.tasks.filter((t) => t.user_id === userId);

  if (filter.startDate && filter.endDate) {
    const start = Number(filter.startDate);
    const end = Number(filter.endDate);
    userTasks = userTasks.filter((t) => {
      if (!t.start_times || t.start_times.length === 0) return true; // unscheduled tasks always returned for sidebar
      // scheduled tasks: check if any segment intersects [start, end]
      return t.start_times.some((st, idx) => {
        const segEnd = st + (t.durations[idx] || 60) * 60;
        return st <= end && segEnd >= start;
      });
    });
  }

  return userTasks;
}

function getTaskById(taskId, userId) {
  const db = loadDB();
  return db.tasks.find((t) => t.id === taskId && t.user_id === userId);
}

function createTask(userId, taskData) {
  const db = loadDB();
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

  db.tasks.push(newTask);
  saveDB(db);
  return newTask;
}

function updateTask(userId, taskId, updates) {
  const db = loadDB();
  const idx = db.tasks.findIndex(
    (t) => t.id === taskId && t.user_id === userId,
  );
  if (idx === -1) {
    throw new Error("Task not found");
  }

  const existing = db.tasks[idx];
  const updatedTask = {
    ...existing,
    ...updates,
    id: existing.id,
    user_id: existing.user_id,
    updated_at: Math.floor(Date.now() / 1000),
  };

  if (updates.start_times !== undefined)
    updatedTask.start_times = updates.start_times;
  if (updates.durations !== undefined)
    updatedTask.durations = updates.durations;
  if (updates.total_duration !== undefined)
    updatedTask.total_duration = Number(updates.total_duration);
  if (updates.is_locked !== undefined)
    updatedTask.is_locked = Boolean(updates.is_locked);
  if (updates.completed !== undefined)
    updatedTask.completed = Boolean(updates.completed);

  db.tasks[idx] = updatedTask;
  saveDB(db);
  return updatedTask;
}

function batchUpdateTasks(userId, taskUpdatesList) {
  const db = loadDB();
  const updatedResults = [];

  for (const item of taskUpdatesList) {
    const idx = db.tasks.findIndex(
      (t) => t.id === item.id && t.user_id === userId,
    );
    if (idx !== -1) {
      db.tasks[idx] = {
        ...db.tasks[idx],
        ...item,
        id: db.tasks[idx].id,
        user_id: userId,
        updated_at: Math.floor(Date.now() / 1000),
      };
      updatedResults.push(db.tasks[idx]);
    }
  }

  saveDB(db);
  return updatedResults;
}

function deleteTask(userId, taskId) {
  const db = loadDB();
  const idx = db.tasks.findIndex(
    (t) => t.id === taskId && t.user_id === userId,
  );
  if (idx === -1) {
    return false;
  }
  db.tasks.splice(idx, 1);
  saveDB(db);
  return true;
}

// User settings
function getSettings(userId) {
  const db = loadDB();
  return (
    db.settings[userId] || {
      bucketHours: 2,
      snapToRuler: false,
      tickPercent: 25,
      theme: "default",
    }
  );
}

function updateSettings(userId, newSettings) {
  const db = loadDB();
  db.settings[userId] = {
    ...(db.settings[userId] || {}),
    ...newSettings,
  };
  saveDB(db);
  return db.settings[userId];
}

// Seed default user if none exists
(function initSeed() {
  if (process.env.VERCEL) return;
  const db = loadDB();
  if (db.users.length === 0) {
    console.log("Seeding default beta account: yassen / password123");
    createUser("yassen", "password123", "admin");
  }
})();

const localDatabase = {
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

module.exports = process.env.VERCEL ? require("./db-mongodb") : localDatabase;
