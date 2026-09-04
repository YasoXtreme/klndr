const {
  buildAuthorizeUrl,
  createPkcePair,
  createState,
  exchangeCode,
  refreshTokens,
  revokeToken,
  redirectError,
  OAuthClientError,
} = require("./oauth-client");

// The Sylla connector.
//
// This is the only file in klndr that knows Sylla exists. Everything it
// exports is the generic Connector interface from connector.js, so the sync
// engine, the routes and the database never learn a thing about syllabuses.
//
// Worth knowing about the source: a Sylla "session" is a row of a shared
// syllabus (subject, month, session number, topic, duration). It has NO due
// date - `month` is a syllabus ordinal, not a calendar month - so what comes
// across is work *owed* and how long it takes. Deciding when to do it is
// klndr's job, which is why imported items arrive unscheduled.

const SCOPES = [
  "profile.read",
  "sessions.read",
  "progress.read",
  "progress.write",
];

// Material Symbols. Every imported session gets the same one, and it is also
// the icon a category invented for a new subject starts with. What tells two
// subjects apart is their category, which carries its own colour.
const ICON = "menu_book";

function config() {
  return {
    baseUrl: (process.env.SYLLA_BASE_URL || "").replace(/\/$/, ""),
    clientId: process.env.SYLLA_CLIENT_ID || "",
    clientSecret: process.env.SYLLA_CLIENT_SECRET || "",
  };
}

function isConfigured() {
  const { baseUrl, clientId, clientSecret } = config();
  return Boolean(baseUrl && clientId && clientSecret);
}

function requireConfig() {
  const values = config();
  if (!isConfigured()) {
    throw new Error(
      "SYLLA_BASE_URL, SYLLA_CLIENT_ID and SYLLA_CLIENT_SECRET must all be set. See .env.example.",
    );
  }
  return values;
}

function beginAuth(redirectUri) {
  const { baseUrl, clientId } = requireConfig();
  const { verifier, challenge } = createPkcePair();
  const state = createState();

  const url = buildAuthorizeUrl(`${baseUrl}/oauth/authorize`, {
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: SCOPES.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  return { url, verifier, state };
}

async function completeAuth(code, verifier, redirectUri) {
  const { baseUrl, clientId, clientSecret } = requireConfig();
  return exchangeCode(`${baseUrl}/api/oauth/token`, {
    code,
    verifier,
    redirectUri,
    clientId,
    clientSecret,
  });
}

async function refresh(refreshToken) {
  const { baseUrl, clientId, clientSecret } = requireConfig();
  return refreshTokens(`${baseUrl}/api/oauth/token`, {
    refreshToken,
    clientId,
    clientSecret,
  });
}

async function revoke(refreshToken) {
  const { baseUrl, clientId, clientSecret } = config();
  if (!baseUrl || !refreshToken) return;
  // Revoking the refresh token ends the whole grant on Sylla's side, so the
  // person's "Connected apps" list stops showing a connection klndr has
  // already forgotten.
  await revokeToken(`${baseUrl}/api/oauth/revoke`, {
    token: refreshToken,
    clientId,
    clientSecret,
  });
}

/**
 * Sylla's own `error_description`, when it sent one.
 *
 * Worth the extra read: Sylla distinguishes "no Bearer header arrived" from
 * "that token is unknown" from "the authorization was revoked", and those have
 * completely different causes. Collapsing them into one message turns a
 * five-second fix into an afternoon.
 */
async function describe(response) {
  try {
    const body = await response.text();
    const parsed = JSON.parse(body);
    return parsed.error_description || parsed.error || "";
  } catch {
    return "";
  }
}

async function assertUsable(response, baseUrl, what) {
  if (response.status >= 300 && response.status < 400) {
    throw redirectError(response, baseUrl);
  }
  if (response.status === 401) {
    const detail = await describe(response);
    throw new OAuthClientError(
      `Sylla rejected the access token${detail ? `: ${detail}` : "."}`,
      401,
      "invalid_grant",
    );
  }
  if (!response.ok) {
    const detail = await describe(response);
    throw new OAuthClientError(
      `Sylla returned ${response.status} ${what}${detail ? `: ${detail}` : "."}`,
      response.status,
      null,
    );
  }
}

async function apiGet(accessToken, path) {
  const { baseUrl } = requireConfig();
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
    // See redirectError: following a redirect here would silently drop the
    // Authorization header and report the result as a rejected token.
    redirect: "manual",
  });

  await assertUsable(response, `${baseUrl}${path}`, `for ${path}`);
  return response.json();
}

async function identify(accessToken) {
  const me = await apiGet(accessToken, "/api/v1/me");
  return { label: `@${me.username}` };
}

/**
 * Everything on the person's syllabus, as NormalizedItems.
 *
 * Asks for `status=all` rather than `status=outstanding` on purpose. With
 * `outstanding`, a session that gets marked done simply vanishes from the
 * response, and so does one that gets deleted - two different things that the
 * sync engine would have to guess between. Asking for everything makes
 * completion an explicit field. The payload is a syllabus, a few hundred rows
 * at most, so there is nothing to save by being clever here.
 */
/**
 * Category names for one payload: the subject name on its own, and the
 * professor spelled out only for subjects whose name another subject in the
 * *same person's* syllabus also uses.
 *
 * Sylla sends `name` and `professor` as separate fields, so nothing here has
 * to parse a name apart. Someone taking one professor per subject - the normal
 * case - gets a board of clean subject columns; someone taking two professors
 * of one subject still gets two columns rather than a merged one.
 */
function categoryNamer(sessions) {
  const idsByName = new Map();
  for (const session of sessions) {
    const { name, id } = session.subject;
    if (!idsByName.has(name)) idsByName.set(name, new Set());
    idsByName.get(name).add(id);
  }
  return (subject) => {
    const ambiguous = (idsByName.get(subject.name) || new Set()).size > 1;
    return ambiguous && subject.professor
      ? `${subject.name} (${subject.professor})`
      : subject.name;
  };
}

/**
 * What one session is called on a klndr block.
 *
 * `M3 S1`, plus the topic when it says something: `M3 S1 · Kinematics`.
 *
 * Three decisions worth keeping:
 *
 * - **The month is not decoration.** Sylla numbers sessions from 1 again in
 *   every month, so "Session 1" on its own names several different pieces of
 *   work and is useless on a calendar.
 * - **The subject is left out.** It is the task's category, which is already
 *   the column header in the tasks panel and the colour on the calendar.
 *   Repeating it spends the width of a block on something the block's own
 *   colour has already said.
 * - **A topic that only repeats the number is dropped.** Some subjects carry
 *   topics literally named "Session 4", which adds nothing next to `S4`.
 */
const NUMBER_ONLY_TOPIC = /^session\s*\d+$/i;

function sessionTitle(session) {
  const label = `M${session.month} S${session.sessionNumber}`;
  const topic = String(session.topic || "").trim();
  return topic && !NUMBER_ONLY_TOPIC.test(topic) ? `${label} · ${topic}` : label;
}

async function fetchItems(accessToken) {
  const data = await apiGet(accessToken, "/api/v1/sessions?status=all");
  const sessions = Array.isArray(data.sessions) ? data.sessions : [];
  const categoryFor = categoryNamer(sessions);

  return sessions.map((session) => ({
    external_id: session.id,
    title: sessionTitle(session),
    // The category name is matched against the person's own categories, and
    // becomes one if they have no category by that name yet. That category is
    // what gives the subject its column, its filter pill and its colour.
    //
    // Sylla's own subject colour is deliberately not passed on: it is arbitrary
    // hex, and klndr picks from a fixed palette so a new category can be given
    // a colour no other category has taken.
    category: categoryFor(session.subject),
    icon: ICON,
    // `estimatedMinutes` rather than `durationMinutes`: Sylla resolves a blank
    // duration against the subject's own average, so this is never zero.
    duration_minutes: Number(session.estimatedMinutes) || 60,
    completed: session.status === "done",
    url: session.url || null,
    revision: session.revision || "",
    // Kept rather than discarded: the professor is not part of any klndr
    // concept today, and holding it means a future tag system reads it off the
    // task instead of needing every imported task re-synced to get it back.
    metadata: {
      subject: session.subject.name,
      professor: session.subject.professor || null,
    },
  }));
}

async function pushCompletion(accessToken, externalId, completed) {
  const { baseUrl } = requireConfig();
  const url = `${baseUrl}/api/v1/progress/${externalId}`;
  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sessionStatus: completed ? "done" : "not_yet" }),
    redirect: "manual",
  });

  await assertUsable(response, url, "updating progress");
}

module.exports = {
  id: "sylla",
  label: "Sylla",
  icon: ICON,
  scopes: SCOPES,
  isConfigured,
  beginAuth,
  completeAuth,
  refresh,
  revoke,
  identify,
  fetchItems,
  pushCompletion,
};
