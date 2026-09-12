const db = require("./db");
const { recordActivity } = require("./activity");

// Session auth, extracted from server.js so route modules can require it.
// Leaving it inline meant a router could not use it without server.js and the
// router importing each other.

// Cookie first, Bearer as a fallback for the desktop wrapper and for scripts.
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

// While a reset is pending, the account can do exactly one thing: set a new
// password. Gating on the server rather than in the UI is the whole point —
// a client-side overlay would leave every data endpoint reachable with the
// temporary password. /api/auth/me and /api/auth/logout call validateSession
// directly rather than passing through here, so they stay reachable too.
const PASSWORD_CHANGE_EXEMPT = new Set(["/api/auth/change-password"]);

// For XHR endpoints: a failure is JSON the client can act on.
async function requireApiAuth(req, res, next) {
  const token = getSessionToken(req);
  const user = await db.validateSession(token);
  if (!user) {
    return res.status(401).json({ error: "Unauthorized: Please log in" });
  }
  req.user = user;
  req.sessionToken = token;

  // req.originalUrl, not req.path: inside a mounted router req.path is
  // relative to the mount point and would never match the full path.
  let pathname = req.originalUrl.split("?")[0];
  while (pathname.length > 1 && pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }
  if (user.must_change_password && !PASSWORD_CHANGE_EXEMPT.has(pathname)) {
    return res.status(403).json({
      error: "Set a new password before continuing",
      code: "password_change_required",
    });
  }

  // After the gate on purpose: an account locked behind a password reset
  // hammering the API is not engagement.
  //
  // Awaited rather than fired and forgotten, because on Vercel the invocation
  // is frozen the moment the response is sent and a pending write is simply
  // dropped. The cost is two small writes at most once every five minutes per
  // person, against the two reads validateSession already does every time.
  //
  // The try/catch is the whole safety guarantee, and next() sits outside it:
  // there is no path where a database hiccup in analytics turns into a 500 on
  // somebody's task save.
  try {
    await recordActivity(user, pathname);
  } catch (err) {
    console.error("Activity write failed (ignored):", err.message);
  }

  next();
}

// For top-level navigations: a failure is a trip to the login page. The OAuth
// connect and callback routes use this rather than requireApiAuth, because the
// browser is following a redirect and would render raw JSON on failure.
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

// Runs after requireApiAuth, which is what puts req.user in place. Replaces
// the identical check that used to be copy-pasted across each admin route.
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Forbidden: Admin access required" });
  }
  next();
}

// The page-navigation counterpart to requireAdmin, for the same reason
// requirePageAuth exists: the browser is following a top-level navigation and
// would render a JSON 403 as raw text.
//
// Redirects to / rather than /login because the person IS logged in - they are
// simply not an admin - and /login bounces a valid session straight back to /
// anyway, which would look like a redirect loop.
function requirePageAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.redirect("/");
  }
  next();
}

module.exports = {
  getSessionToken,
  requireApiAuth,
  requirePageAuth,
  requireAdmin,
  requirePageAdmin,
};
