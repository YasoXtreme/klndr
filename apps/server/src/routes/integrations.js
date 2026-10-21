const express = require("express");
const db = require("../db");
const { requireApiAuth, requirePageAuth } = require("../auth-middleware");
const { getConnector, listProviders } = require("../integrations/registry");
const { encrypt, decrypt, isConfigured } = require("../integrations/crypto");
const { safeEqual } = require("../integrations/oauth-client");
const { tokenFields } = require("../integrations/tokens");
const { syncProvider, pushCompletionNow } = require("../integrations/sync");

// Integration routes, mounted at /api/integrations.
//
// One set of routes for every provider: the provider id is a path parameter
// looked up in the registry, never a branch. Adding an integration adds no
// routes.

const router = express.Router();

// Holds the PKCE verifier and the state while the person is away authorizing.
// httpOnly so page scripts cannot read it, and SameSite=Lax so it still
// arrives on the way back, which is a top-level GET navigation.
const FLOW_COOKIE = "klndr_oauth_flow";
const FLOW_MAX_AGE_MS = 10 * 60 * 1000;

function flowCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: FLOW_MAX_AGE_MS,
    path: "/",
  };
}

/**
 * The callback URL this deployment presents to a provider.
 *
 * Must match what is registered on the provider side byte for byte, which is
 * why it comes from configuration rather than from the request: behind a proxy
 * the Host header is not reliably the public name, and a mismatch is a failure
 * halfway through the flow rather than at startup.
 */
function redirectUriFor(providerId) {
  const base = (process.env.KLNDR_BASE_URL || "").replace(/\/$/, "");
  if (!base) {
    throw new Error("KLNDR_BASE_URL must be set to connect an integration. See .env.example.");
  }
  return `${base}/api/integrations/${providerId}/callback`;
}

function backToApp(res, outcome, detail) {
  const params = new URLSearchParams({ integration: outcome });
  if (detail) params.set("detail", detail);
  return res.redirect(`/?${params.toString()}`);
}

// What the integrations tab renders: every provider, plus this person's
// connection to it if there is one.
router.get("/", requireApiAuth, async (req, res) => {
  try {
    const connections = await db.listIntegrations(req.user.id);
    const byProvider = new Map(connections.map((row) => [row.provider, row]));

    const providers = listProviders().map((provider) => {
      const connection = byProvider.get(provider.id);
      return {
        ...provider,
        // Surfaced so the UI can say what is wrong rather than failing at the
        // click, which is the only visible symptom of a missing env var.
        available: provider.configured && isConfigured(),
        connected: Boolean(connection),
        account_label: connection ? connection.account_label : null,
        last_synced_at: connection ? connection.last_synced_at || null : null,
        last_sync_error: connection ? connection.last_sync_error || null : null,
        status: connection ? connection.status || "connected" : null,
        dismissed_count: connection ? (connection.dismissed_ids || []).length : 0,
      };
    });

    res.json({ providers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start the flow. A top-level navigation, not a fetch, because it 302s away.
router.get("/:provider/connect", requirePageAuth, async (req, res) => {
  const connector = getConnector(req.params.provider);
  if (!connector) return backToApp(res, "unknown_provider");

  try {
    const redirectUri = redirectUriFor(connector.id);
    const { url, verifier, state } = connector.beginAuth(redirectUri);

    // The verifier is a secret and the user id binds this flow to the person
    // who started it, so a callback cannot be replayed into someone else's
    // session. Encrypted because the cookie leaves our process.
    res.cookie(
      FLOW_COOKIE,
      encrypt(
        JSON.stringify({
          provider: connector.id,
          state,
          verifier,
          userId: req.user.id,
        }),
      ),
      flowCookieOptions(),
    );

    res.redirect(url);
  } catch (err) {
    console.error("Failed to start OAuth flow:", err.message);
    backToApp(res, "error", err.message);
  }
});

// Come back from the provider.
router.get("/:provider/callback", requirePageAuth, async (req, res) => {
  const connector = getConnector(req.params.provider);

  // One-shot: cleared whether this succeeds or fails, so a stale verifier can
  // never be reused.
  const raw = req.cookies ? req.cookies[FLOW_COOKIE] : null;
  res.clearCookie(FLOW_COOKIE, { path: "/" });

  if (!connector) return backToApp(res, "unknown_provider");
  if (req.query.error) {
    return backToApp(res, "denied", String(req.query.error_description || ""));
  }

  let flow = null;
  try {
    flow = raw ? JSON.parse(decrypt(raw)) : null;
  } catch {
    flow = null;
  }

  const code = req.query.code;
  const state = req.query.state;
  if (
    !flow ||
    !code ||
    !state ||
    flow.provider !== connector.id ||
    !safeEqual(String(state), flow.state) ||
    // Bound to the person who started it: without this, a callback URL handed
    // to a signed-in victim would attach the attacker's account to them.
    flow.userId !== req.user.id
  ) {
    return backToApp(res, "bad_state");
  }

  try {
    const redirectUri = redirectUriFor(connector.id);
    const tokenSet = await connector.completeAuth(String(code), flow.verifier, redirectUri);
    const identity = await connector.identify(tokenSet.access_token);

    await db.upsertIntegration(req.user.id, connector.id, {
      ...tokenFields(tokenSet),
      account_label: identity.label,
    });

    // First sync immediately, so the tasks panel is populated by the time the
    // page finishes loading rather than after some later trigger.
    try {
      await syncProvider(req.user.id, connector, { force: true });
    } catch (err) {
      console.error("First sync after connect failed:", err.message);
    }

    backToApp(res, "connected");
  } catch (err) {
    console.error("OAuth callback failed:", err.message);
    backToApp(res, "error", err.message);
  }
});

router.post("/:provider/sync", requireApiAuth, async (req, res) => {
  const connector = getConnector(req.params.provider);
  if (!connector) return res.status(404).json({ error: "Unknown provider" });

  try {
    const result = await syncProvider(req.user.id, connector, {
      force: Boolean(req.body && req.body.force),
    });
    res.json({ result });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// Fired when an imported task's completion changes, so ticking something off
// reaches the source app now rather than at the next sync.
router.post("/:provider/push", requireApiAuth, async (req, res) => {
  const connector = getConnector(req.params.provider);
  if (!connector) return res.status(404).json({ error: "Unknown provider" });

  const taskId = req.body && req.body.taskId;
  if (!taskId) return res.status(400).json({ error: "taskId is required" });

  try {
    const pushed = await pushCompletionNow(req.user.id, connector, taskId);
    res.json({ pushed });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// Bring back everything that was deleted locally. Without this an accidental
// delete is permanent short of disconnecting.
router.post("/:provider/undismiss", requireApiAuth, async (req, res) => {
  const connector = getConnector(req.params.provider);
  if (!connector) return res.status(404).json({ error: "Unknown provider" });

  try {
    await db.clearDismissedSourceItems(req.user.id, connector.id);
    const result = await syncProvider(req.user.id, connector, { force: true });
    res.json({ result });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.delete("/:provider", requireApiAuth, async (req, res) => {
  const connector = getConnector(req.params.provider);
  if (!connector) return res.status(404).json({ error: "Unknown provider" });

  try {
    const integration = await db.getIntegration(req.user.id, connector.id);
    if (!integration) return res.status(404).json({ error: "Not connected" });

    // Tell the source app first, so its own connected-apps list does not keep
    // showing a connection klndr has already forgotten.
    try {
      await connector.revoke(decrypt(integration.refresh_token));
    } catch (err) {
      console.error("Revoke on disconnect failed (continuing):", err.message);
    }

    // Imported tasks that were never scheduled go; ones already on the
    // calendar stay, because disconnecting should not delete work somebody has
    // planned their week around.
    //
    // The kept ones deliberately KEEP their source_app and source_id. Clearing
    // those would look tidier, but it throws away the key that lets a later
    // reconnect re-adopt them: the sync would find no match, import the same
    // session again, and the person would be left with a scheduled block and a
    // duplicate card for the same piece of work.
    const imported = await db.getTasksBySource(req.user.id, connector.id);
    let kept = 0;
    let deleted = 0;
    for (const task of imported) {
      const scheduled = Array.isArray(task.start_times) && task.start_times.length > 0;
      if (scheduled) {
        kept += 1;
      } else {
        await db.deleteTask(req.user.id, task.id);
        deleted += 1;
      }
    }

    await db.deleteIntegration(req.user.id, connector.id);
    res.json({ disconnected: true, kept, deleted });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
