const express = require("express");
const path = require("path");
const cookieParser = require("cookie-parser");
const db = require("./server/db");
const categories = require("./server/categories");
const {
  getSessionToken,
  requireApiAuth,
  requirePageAuth,
  requireAdmin,
} = require("./server/auth-middleware");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  cookieParser(process.env.SESSION_SECRET || "klndr_secret_session_salt_2026"),
);

// getSessionToken / requireApiAuth / requirePageAuth now live in
// server/auth-middleware.js, so route modules can share them.

// ==========================================
// 1. PUBLIC ROUTES (Login & Public Assets)
// ==========================================

// Serve public static assets (fonts, brand marks, login css/js)
app.use("/public", express.static(path.join(__dirname, "public")));
app.use("/assets", express.static(path.join(__dirname, "public", "assets")));

// Both pages point at the icons explicitly, so this is only ever hit by
// clients that probe the conventional path instead of reading the markup.
app.get("/favicon.ico", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "assets", "favicon.ico"));
});

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
    await db.changePassword(
      req.user.id,
      currentPassword,
      newPassword,
      req.sessionToken,
    );
    res.json({ message: "Password updated successfully" });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Admin endpoints for beta user management
app.get(
  "/api/admin/users",
  requireApiAuth,
  requireAdmin,
  async (req, res) => {
    const users = await db.getAllUsers();
    res.json({ users });
  },
);

app.post(
  "/api/admin/create-user",
  requireApiAuth,
  requireAdmin,
  async (req, res) => {
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
  },
);

app.delete(
  "/api/admin/users/:username",
  requireApiAuth,
  requireAdmin,
  async (req, res) => {
    const success = await db.deleteUser(req.params.username);
    if (!success) {
      return res.status(404).json({ error: "User not found" });
    }
    res.json({ message: "User deleted successfully" });
  },
);

// The only account recovery path klndr has: no user document carries an email,
// so there is nowhere to send a reset link and an admin has to pass the
// temporary password on out-of-band. The server generates it rather than
// letting the admin pick one, and it is returned exactly once.
app.post(
  "/api/admin/users/:username/reset-password",
  requireApiAuth,
  requireAdmin,
  async (req, res) => {
    const result = await db.adminResetPassword(req.params.username);
    if (!result) {
      return res.status(404).json({ error: "User not found" });
    }
    res.json({
      message: "Password reset. This is shown once.",
      username: result.user.username,
      tempPassword: result.tempPassword,
    });
  },
);

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

// Categories API
//
// The list is per user and starts empty. A user who predates categories is
// migrated on their first read here, from the categories their tasks actually
// carry - see server/categories.js.
app.get("/api/categories", requireApiAuth, async (req, res) => {
  try {
    const list = await categories.listCategories(req.user.id);
    res.json({ categories: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/categories", requireApiAuth, async (req, res) => {
  try {
    const category = await categories.createCategory(req.user.id, req.body);
    res.json({ category });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// `applyToTasks` pushes the new colour and icon onto the tasks already wearing
// this category. It happens here rather than on the client because the client
// only holds the current week plus everything unscheduled, so it can neither
// count the tasks honestly nor reach all of them.
app.put("/api/categories/:id", requireApiAuth, async (req, res) => {
  try {
    const result = await categories.updateCategory(
      req.user.id,
      req.params.id,
      req.body,
    );
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/categories/:id", requireApiAuth, async (req, res) => {
  try {
    const result = await categories.deleteCategory(req.user.id, req.params.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Announcements API
app.get("/api/announcements", requireApiAuth, async (req, res) => {
  try {
    const [announcements, userLastSeenId] = await Promise.all([
      db.getAllAnnouncements(),
      db.getUserLastSeenAnnouncementId(req.user.id),
    ]);
    res.json({ announcements, user_last_seen_id: userLastSeenId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/announcements/missed", requireApiAuth, async (req, res) => {
  try {
    const [all, lastSeenId] = await Promise.all([
      db.getAllAnnouncements(),
      db.getUserLastSeenAnnouncementId(req.user.id),
    ]);
    const missed = all.filter((a) => a.id > lastSeenId);
    res.json({ announcements: missed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/announcements", requireApiAuth, requireAdmin, async (req, res) => {
  const { title, content, header_image_url } = req.body;
  if (!title || !content) {
    return res.status(400).json({ error: "Title and content are required" });
  }
  try {
    const announcement = await db.createAnnouncement(req.user.id, {
      title,
      content,
      header_image_url,
    });
    res.status(201).json({ announcement });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put("/api/announcements/seen", requireApiAuth, async (req, res) => {
  const { last_seen_id } = req.body;
  if (last_seen_id === undefined || last_seen_id === null) {
    return res.status(400).json({ error: "last_seen_id is required" });
  }
  try {
    await db.updateUserLastSeenAnnouncementId(req.user.id, last_seen_id);
    res.json({ message: "Last seen announcement updated" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Integrations (Sylla and anything added to the connector registry later).
// Must be registered before the catch-all below, which would otherwise turn an
// OAuth callback into a redirect to /login. Guards are per-route inside the
// router: JSON 401s for the XHR endpoints, a redirect for the two that are
// top-level navigations.
app.use("/api/integrations", require("./server/routes/integrations"));

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
