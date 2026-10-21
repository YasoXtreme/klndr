const db = require("../db");
const { encrypt, decrypt } = require("./crypto");
const { OAuthClientError } = require("./oauth-client");

// Access token management.
//
// Storage-shaped rather than protocol-shaped, which is why it lives here and
// not in a connector: every provider needs exactly this, and a second one
// should not have to write any concurrency code.

// Refresh a little before expiry, so a token does not die mid-request.
const SKEW_SECONDS = 60;
// Long enough for a token POST, short enough that a killed invocation does not
// strand the connection for long.
const LEASE_SECONDS = 15;
const POLL_ATTEMPTS = 10;
const POLL_INTERVAL_MS = 300;

class NotConnectedError extends Error {
  constructor(provider) {
    super(`No ${provider} connection for this account.`);
    this.name = "NotConnectedError";
    this.status = 404;
  }
}

class ReauthRequiredError extends Error {
  constructor(provider) {
    super(`The ${provider} connection has expired. Reconnect it to keep syncing.`);
    this.name = "ReauthRequiredError";
    this.status = 401;
  }
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Writes a fresh TokenSet, encrypting both tokens on the way in. */
function tokenFields(tokenSet) {
  return {
    access_token: encrypt(tokenSet.access_token),
    refresh_token: encrypt(tokenSet.refresh_token),
    expires_at: now() + Number(tokenSet.expires_in || 3600),
    scopes: (tokenSet.scope || "").split(" ").filter(Boolean),
    status: "connected",
    last_sync_error: null,
  };
}

/**
 * A usable access token for this connection, refreshing if needed.
 *
 * Performs writes, so call it once per request and thread the result through
 * rather than calling it per API call: a sync that made several requests would
 * otherwise race itself.
 */
async function getAccessToken(userId, connector) {
  const doc = await db.getIntegration(userId, connector.id);
  if (!doc) throw new NotConnectedError(connector.id);
  if (doc.status === "reauth_required") throw new ReauthRequiredError(connector.id);

  if (doc.expires_at && doc.expires_at > now() + SKEW_SECONDS) {
    return decrypt(doc.access_token);
  }

  // Compare-and-swap on the refresh token we just read. If another invocation
  // already rotated it, this matches nothing and we fall through to polling
  // instead of spending a token that is no longer current.
  const claimed = await db.claimIntegrationRefresh(
    userId,
    connector.id,
    doc.refresh_token,
    LEASE_SECONDS,
  );

  if (claimed) {
    try {
      const tokenSet = await connector.refresh(decrypt(claimed.refresh_token));
      await db.releaseIntegrationRefresh(userId, connector.id, tokenFields(tokenSet));
      return tokenSet.access_token;
    } catch (err) {
      if (err instanceof OAuthClientError && err.needsReauth) {
        // The grant is gone on the other side. Record it so every later call
        // fails fast with something the UI can explain, instead of retrying a
        // refresh that can never succeed.
        await db.releaseIntegrationRefresh(userId, connector.id, {
          status: "reauth_required",
          last_sync_error: err.message,
        });
        throw new ReauthRequiredError(connector.id);
      }
      // Transient. Release the lease so the next attempt is not blocked.
      await db.releaseIntegrationRefresh(userId, connector.id, {});
      throw err;
    }
  }

  // Someone else holds the lease. Wait for their result rather than racing
  // them to the token endpoint.
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    await sleep(POLL_INTERVAL_MS);
    const fresh = await db.getIntegration(userId, connector.id);
    if (!fresh) throw new NotConnectedError(connector.id);
    if (fresh.status === "reauth_required") throw new ReauthRequiredError(connector.id);
    if (fresh.expires_at && fresh.expires_at > now() + SKEW_SECONDS) {
      return decrypt(fresh.access_token);
    }
  }

  throw new Error("Timed out waiting for another request to refresh the connection.");
}

module.exports = {
  getAccessToken,
  tokenFields,
  NotConnectedError,
  ReauthRequiredError,
};
