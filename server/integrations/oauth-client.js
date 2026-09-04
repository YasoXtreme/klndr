const crypto = require("crypto");

// Generic OAuth 2.0 client helpers.
//
// Nothing here knows which provider it is talking to: a connector supplies the
// URLs and its credentials, this supplies the protocol. A second integration
// should be able to reuse all of it.

/** RFC 7636. A verifier is kept by us; only its S256 hash goes to the browser. */
function createPkcePair() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}

/** One-time value tying a callback back to the request that started it. */
function createState() {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * Constant-time comparison for the state check.
 *
 * `===` on a secret leaks its length and, in principle, its prefix through
 * timing. The lengths are compared first because timingSafeEqual throws on a
 * mismatch rather than returning false.
 */
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function buildAuthorizeUrl(baseUrl, params) {
  const url = new URL(baseUrl);
  Object.entries(params).forEach(([name, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(name, value);
    }
  });
  return url.toString();
}

/**
 * Posts a form to a token endpoint and returns the parsed TokenSet.
 *
 * Errors carry the provider's own `error` code where there is one, because
 * "invalid_grant" is the difference between "retry" and "the person has to
 * reconnect", and a generic message would hide that.
 */
async function postForm(tokenUrl, body) {
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(body).toString(),
  });

  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A provider that redirected us to a sign-in page lands here. Say so,
    // rather than surfacing a JSON parse error that looks like our bug.
    throw new OAuthClientError(
      `Token endpoint returned ${response.status} with a non-JSON body.`,
      response.status,
      null,
    );
  }

  if (!response.ok) {
    throw new OAuthClientError(
      parsed.error_description || parsed.error || `Token request failed (${response.status}).`,
      response.status,
      parsed.error || null,
    );
  }

  return parsed;
}

class OAuthClientError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = "OAuthClientError";
    this.status = status;
    this.code = code;
  }

  /** True when reconnecting is the only way forward, so callers stop retrying. */
  get needsReauth() {
    return this.code === "invalid_grant" || this.code === "invalid_client";
  }
}

function exchangeCode(tokenUrl, options) {
  return postForm(tokenUrl, {
    grant_type: "authorization_code",
    code: options.code,
    redirect_uri: options.redirectUri,
    code_verifier: options.verifier,
    client_id: options.clientId,
    client_secret: options.clientSecret,
  });
}

function refreshTokens(tokenUrl, options) {
  return postForm(tokenUrl, {
    grant_type: "refresh_token",
    refresh_token: options.refreshToken,
    client_id: options.clientId,
    client_secret: options.clientSecret,
  });
}

async function revokeToken(revokeUrl, options) {
  // Best effort: a failure here must not stop a disconnect, or someone could
  // be stuck connected because the other end is down.
  try {
    await fetch(revokeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: options.token,
        client_id: options.clientId,
        client_secret: options.clientSecret,
      }).toString(),
    });
  } catch (err) {
    console.error("Token revocation failed (continuing):", err.message);
  }
}

module.exports = {
  createPkcePair,
  createState,
  safeEqual,
  buildAuthorizeUrl,
  exchangeCode,
  refreshTokens,
  revokeToken,
  OAuthClientError,
};
