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

// For XHR endpoints: a failure is JSON the client can act on.
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

module.exports = { getSessionToken, requireApiAuth, requirePageAuth };
