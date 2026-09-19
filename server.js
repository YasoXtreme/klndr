const express = require("express");
const path = require("path");
const cookieParser = require("cookie-parser");
const db = require("./server/db");
const categories = require("./server/categories");
const pages = require("./server/pages");
const {
  getSessionToken,
  requireApiAuth,
  requirePageAuth,
  requireAdmin,
  requirePageAdmin,
} = require("./server/auth-middleware");

const app = express();
const PORT = process.env.PORT || 3000;

// Marks the first request an instance serves, so a slow load can be told
// apart from a cold one in the browser's timing panel.
let servedAny = false;
app.use((req, res, next) => {
  if (!servedAny) {
    servedAny = true;
    res.append("Server-Timing", 'cold;desc="first request on this instance"');
  }
  next();
});

// A local-only stand-in for a slow server, for working on the loading states:
// KLNDR_DELAY_MS=3000 npm run dev. Delays API calls and pages, never the files
// they load, and is ignored outright on Vercel.
const DEV_DELAY_MS = process.env.VERCEL
  ? 0
  : Number(process.env.KLNDR_DELAY_MS) || 0;
if (DEV_DELAY_MS > 0) {
  app.use((req, res, next) => {
    if (path.extname(req.path)) return next();
    setTimeout(next, DEV_DELAY_MS);
  });
}

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

// Serve public static assets (fonts, brand marks, login css/js). How long each
// may be cached is decided in server/pages.js.
app.use(
  "/public",
  express.static(path.join(__dirname, "public"), pages.staticOptions("public")),
);
app.use(
  "/assets",
  express.static(
    path.join(__dirname, "public", "assets"),
    pages.staticOptions("assets"),
  ),
);

// Both pages point at the icons explicitly, so this is only ever hit by
// clients that probe the conventional path instead of reading the markup.
app.get("/favicon.ico", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "assets", "favicon.ico"), {
    maxAge: "7d",
  });
});

// Login page route
app.get("/login", async (req, res, next) => {
  let user;
  try {
    user = await db.validateSession(getSessionToken(req));
  } catch (err) {
    return next(err);
  }
  if (user) {
    return res.redirect("/");
  }
  pages.page("login")(req, res, next);
});

// Auth API Endpoints
app.post("/api/auth/login", async (req, res, next) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res
      .status(400)
      .json({ error: "Username and password are required" });
  }

  let user;
  try {
    user = await db.getUserByUsername(username);
  } catch (err) {
    return next(err);
  }
  if (!user || !db.verifyPassword(user, password)) {
    return res.status(401).json({ error: "Invalid username or password" });
  }

  let token;
  try {
    token = await db.createSession(user.id);

    // The only place a login is observed. Deliberately does not touch
    // last_seen_at: leaving that stale is what makes the next API call open the
    // day's activity window, so a login always registers as activity without
    // this handler having to know how that works.
    await db.recordLogin(user.id);
  } catch (err) {
    return next(err);
  }

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

app.post("/api/auth/logout", async (req, res, next) => {
  const token = getSessionToken(req);
  if (token) {
    try {
      await db.destroySession(token);
    } catch (err) {
      return next(err);
    }
  }
  res.clearCookie("klndr_session");
  res.json({ message: "Logged out successfully" });
});

app.get("/api/auth/me", async (req, res, next) => {
  let user;
  try {
    user = await db.validateSession(getSessionToken(req));
  } catch (err) {
    return next(err);
  }
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
    const { username, role } = req.body;
    if (!username) {
      return res.status(400).json({ error: "Username required" });
    }

    // Same contract as reset-password: the server generates the temporary
    // password and it is returned exactly once.
    try {
      const result = await db.createUser(username, role || "user");
      res.status(201).json({
        message: "User created. The password is shown once.",
        user: result.user,
        tempPassword: result.tempPassword,
      });
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

// Guard protected CSS and JS. Cached privately, in the browser that got past
// the guard, and only for as long as server/pages.js allows.
app.use(
  "/protected",
  requirePageAuth,
  express.static(
    path.join(__dirname, "protected"),
    pages.staticOptions("protected"),
  ),
);

// The admin page, and its own assets beside it. They live in a sibling
// directory rather than under protected/, and that is a security boundary
// rather than tidiness.
//
// Route ordering cannot protect a subdirectory of a statically-served root.
// Express matches layers against the raw, unnormalized pathname, so a request
// for /protected/x/../admin/analytics.js never matches a /protected/admin
// mount - it matches /protected, and send() then normalizes the path and
// resolves it right back down into the directory the guard was supposed to
// cover. send() only refuses when the ".." escapes ABOVE the root, which is
// exactly what reaching a sibling requires. Hence: sibling.
//
// Every admin tool is one page, admin/index.html, whose router reads the path,
// so any /admin URL that is not a file gets that page. The link into it is
// hidden for non-admins, but that is presentation - these guards are the
// control, and every endpoint the page calls is guarded again on its own mount.
app.use(
  "/admin",
  requirePageAuth,
  requirePageAdmin,
  express.static(
    path.join(__dirname, "admin"),
    pages.staticOptions("admin", { index: false, redirect: false }),
  ),
  (req, res, next) => {
    if (req.method !== "GET" || path.extname(req.path)) return next();
    pages.page("admin")(req, res, next);
  },
);

// Root route: serves protected index.html only if authenticated
app.get("/", requirePageAuth, pages.page("app"));

// Where the admin tools lived before /admin, so old links still land. The
// guards on /admin decide who gets in.
app.get("/analytics", (req, res) => res.redirect("/admin/analytics"));
app.get("/announcements", (req, res) => res.redirect("/admin/announcements"));

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

// Announcements. The people-facing half is scoped to req.user throughout; the
// Studio's half is admin-only JSON with its guards on the mount, like analytics.
app.use(
  "/api/announcements",
  requireApiAuth,
  require("./server/routes/announcements"),
);

app.use(
  "/api/admin/announcements",
  requireApiAuth,
  requireAdmin,
  require("./server/routes/admin-announcements"),
);

// The media library behind the Studio. Uploads are signed here and sent by the
// browser straight to R2, so no route under this ever receives file bytes.
app.use(
  "/api/admin/media",
  requireApiAuth,
  requireAdmin,
  require("./server/routes/admin-media"),
);

// Announcement media in a private bucket, signed per read. A page guard rather
// than an API one: these are <img> and <video> requests, for which a JSON 401
// means nothing. With a public bucket the app links to the bucket directly and
// this route only redirects there.
app.get("/media/*", requirePageAuth, require("./server/media").serveObject);

// Integrations (Sylla and anything added to the connector registry later).
// Must be registered before the catch-all below, which would otherwise turn an
// OAuth callback into a redirect to /login. Guards are per-route inside the
// router: JSON 401s for the XHR endpoints, a redirect for the two that are
// top-level navigations.
app.use("/api/integrations", require("./server/routes/integrations"));

// Guards hoisted to the mount, unlike the integrations router: every route
// under this one is admin-only JSON, with no navigation among them.
app.use(
  "/api/admin/analytics",
  requireApiAuth,
  requireAdmin,
  require("./server/routes/analytics"),
);

// Catch-all 404 handler. A path with a file extension is a missing file, not
// a page, and gets a plain 404: redirecting it to /login would hand a script
// tag an HTML page (redirect() also replaces the 404 with a 302).
app.use((req, res) => {
  if (path.extname(req.path)) {
    return res.status(404).type("text").send("Not found");
  }
  if (req.accepts("html")) {
    return res.redirect("/login");
  }
  res.status(404).json({ error: "Endpoint not found" });
});

// Last. Express 4 only gets here through next(err), which the auth guards and
// the pages now use: before, a database error inside an async handler left
// the request open until the function timed out, which looked exactly like
// the app freezing.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const fromDatabase = Boolean(err && typeof err.name === "string" && err.name.startsWith("Mongo"));
  const status = err.status || err.statusCode || (fromDatabase ? 503 : 500);
  if (status >= 500) console.error(`${req.method} ${req.originalUrl} failed:`, err);
  if (res.headersSent) return res.end();

  const message = fromDatabase
    ? "klndr can't reach its database right now. Try again in a moment."
    : status >= 500
      ? "Something went wrong on klndr's side."
      : err.message || "Bad request";
  res.status(status).set("Cache-Control", "no-store");
  if (req.path.startsWith("/api/")) return res.json({ error: message });
  res.type("text").send(message);
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
