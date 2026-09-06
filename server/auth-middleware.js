const db = require("./db");

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

module.exports = {
  getSessionToken,
  requireApiAuth,
  requirePageAuth,
  requireAdmin,
};
