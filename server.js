const express = require("express");
const path = require("path");
const cookieParser = require("cookie-parser");
const db = require("./server/db");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  cookieParser(process.env.SESSION_SECRET || "klndr_secret_session_salt_2026"),
);

// Helper to extract session token from cookie or Authorization header
function getSessionToken(req) {
  if (req.cookies && req.cookies.klndr_session) {
    return req.cookies.klndr_session;
  }
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.substring(7);
  }
  return null;
}

// Authentication middleware for API routes
async function requireApiAuth(req, res, next) {
  const token = getSessionToken(req);
  const user = await db.validateSession(token);
  if (!user) {
    return res.status(401).json({ error: "Unauthorized: Please log in" });
  }
  req.user = user;
  req.sessionToken = token;
  next();
}

// Authentication middleware for Protected Page & Protected Assets
async function requirePageAuth(req, res, next) {
  const token = getSessionToken(req);
  const user = await db.validateSession(token);
  if (!user) {
    return res.redirect("/login");
  }
  req.user = user;
  req.sessionToken = token;
  next();
}

// ==========================================
// 1. PUBLIC ROUTES (Login & Public Assets)
// ==========================================

// Serve public static assets (fonts, logo, login css/js)
app.use("/public", express.static(path.join(__dirname, "public")));
app.use("/assets", express.static(path.join(__dirname, "public", "assets")));

// Login page route
app.get("/login", async (req, res) => {
  const token = getSessionToken(req);
  const user = await db.validateSession(token);
  if (user) {
    return res.redirect("/");
  }
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

// Auth API Endpoints
app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res
      .status(400)
      .json({ error: "Username and password are required" });
  }

  const user = await db.getUserByUsername(username);
  if (!user || !db.verifyPassword(user, password)) {
    return res.status(401).json({ error: "Invalid username or password" });
  }

  const token = await db.createSession(user.id);

  // Set secure HTTP-only cookie (30 days)
  res.cookie("klndr_session", token, {
    httpOnly: true,
    maxAge: 30 * 24 * 60 * 60 * 1000,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });

  const { password_hash, ...safeUser } = user;
  res.json({
    message: "Login successful",
    token,
    user: safeUser,
  });
});

app.post("/api/auth/logout", async (req, res) => {
  const token = getSessionToken(req);
  if (token) {
    await db.destroySession(token);
  }
  res.clearCookie("klndr_session");
  res.json({ message: "Logged out successfully" });
});

app.get("/api/auth/me", async (req, res) => {
  const token = getSessionToken(req);
  const user = await db.validateSession(token);
  if (!user) {
    return res.status(401).json({ user: null });
  }
  res.json({ user });
});

// Account Settings Endpoints
app.post("/api/auth/change-username", requireApiAuth, async (req, res) => {
  const { newUsername } = req.body;
  if (!newUsername) {
    return res.status(400).json({ error: "New username is required" });
  }
  try {
    const updatedUser = await db.changeUsername(req.user.id, newUsername);
    res.json({ message: "Username updated successfully", user: updatedUser });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/auth/change-password", requireApiAuth, async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "All fields are required" });
  }
  if (newPassword !== confirmPassword) {
    return res
      .status(400)
      .json({ error: "New password and confirm password do not match" });
  }
  try {
    await db.changePassword(req.user.id, currentPassword, newPassword);
    res.json({ message: "Password updated successfully" });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Admin endpoints for beta user management
app.get("/api/admin/users", requireApiAuth, async (req, res) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Forbidden: Admin access required" });
  }
  const users = await db.getAllUsers();
  res.json({ users });
});

app.post("/api/admin/create-user", requireApiAuth, async (req, res) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Forbidden: Admin access required" });
  }

  const { username, password, role } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required" });
  }

  try {
    const newUser = await db.createUser(username, password, role || "user");
    res
      .status(201)
      .json({ message: "User created successfully", user: newUser });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/admin/users/:username", requireApiAuth, async (req, res) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Forbidden: Admin access required" });
  }

  const success = await db.deleteUser(req.params.username);
  if (!success) {
    return res.status(404).json({ error: "User not found" });
  }
  res.json({ message: "User deleted successfully" });
});

// ==========================================
// 2. PROTECTED STATIC ASSETS & APP CODE
// ==========================================

// Guard protected CSS and JS
app.use(
  "/protected",
  requirePageAuth,
  express.static(path.join(__dirname, "protected")),
);

// Root route: serves protected index.html only if authenticated
app.get("/", requirePageAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "protected", "index.html"));
});

// ==========================================
// 3. PROTECTED REST API ENDPOINTS
// ==========================================

// Tasks CRUD
app.get("/api/tasks", requireApiAuth, async (req, res) => {
  const { startDate, endDate } = req.query;
  const tasks = await db.getTasks(req.user.id, { startDate, endDate });
  res.json({ tasks });
});

app.post("/api/tasks", requireApiAuth, async (req, res) => {
  try {
    const task = await db.createTask(req.user.id, req.body);
    res.status(201).json({ task });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put("/api/tasks/:id", requireApiAuth, async (req, res) => {
  try {
    const task = await db.updateTask(req.user.id, req.params.id, req.body);
    res.json({ task });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/tasks/batch-update", requireApiAuth, async (req, res) => {
  const { updates } = req.body;
  if (!Array.isArray(updates)) {
    return res.status(400).json({ error: "Updates must be an array" });
  }
  const results = await db.batchUpdateTasks(req.user.id, updates);
  res.json({ updated: results });
});

app.delete("/api/tasks/:id", requireApiAuth, async (req, res) => {
  const success = await db.deleteTask(req.user.id, req.params.id);
  if (!success) {
    return res.status(404).json({ error: "Task not found" });
  }
  res.json({ message: "Task deleted successfully" });
});

// Settings API
app.get("/api/settings", requireApiAuth, async (req, res) => {
  const settings = await db.getSettings(req.user.id);
  res.json({ settings });
});

app.put("/api/settings", requireApiAuth, async (req, res) => {
  const settings = await db.updateSettings(req.user.id, req.body);
  res.json({ settings });
});

// Catch-all 404 handler
app.use((req, res) => {
  if (req.accepts("html")) {
    return res.status(404).redirect("/login");
  }
  res.status(404).json({ error: "Endpoint not found" });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`
======================================================
  Klndr Server running on http://localhost:${PORT}
  Beta Login page:       http://localhost:${PORT}/login
  Protected App:         http://localhost:${PORT}/
======================================================
`);
  });
}

module.exports = app;
