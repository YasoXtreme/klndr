const db = require("./db");

// How long one activity window is. Every metric derived from `pings` is
// denominated in this, so changing it rewrites the meaning of historical rows -
// it is not a tuning knob.
const WINDOW_SECONDS = 5 * 60;

// The admin's own dashboard is not engagement. Leaving this out would let an
// admin refreshing the page for an hour register as a twelve-ping day, which
// makes the one person reading the numbers the one distorting them.
const EXCLUDED_PREFIX = "/api/admin/analytics";

/**
 * Note that this person was here, at most once every WINDOW_SECONDS.
 *
 * Hung off requireApiAuth because that is the single point every authenticated
 * XHR passes. That is only affordable because the throttle is free:
 * validateSession has already loaded the whole user document, so the common
 * path is a subtraction rather than a query, and on all but one request in
 * twelve minutes this function touches the database not at all.
 */
async function recordActivity(user, pathname) {
  if (!user || !user.id) return;
  if (pathname.startsWith(EXCLUDED_PREFIX)) return;

  const now = Math.floor(Date.now() / 1000);
  if (user.last_seen_at && now - user.last_seen_at < WINDOW_SECONDS) return;

  // Compare-and-swap, not read-then-write. Two requests arriving together both
  // read the same stale last_seen_at above; without this they would both count
  // the window and `pings` would stop meaning what it says.
  const won = await db.claimActivityWindow(
    user.id,
    now,
    now - WINDOW_SECONDS,
  );
  if (!won) return;

  await db.recordActivityDay(user.id, now);
}

module.exports = { recordActivity, WINDOW_SECONDS };
