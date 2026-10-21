// One error shape for the announcement and media modules.
//
// A service throws an HttpError when the failure is the caller's to fix - a
// missing field, a stale revision, a file that is too big - and the route turns
// it into that status and sentence without needing to know which layer threw.
// Anything else is a 500 with a generic sentence: the detail goes to the log,
// not to the browser.

class HttpError extends Error {
  constructor(status, message, { code, details } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Wrap a route body that returns its JSON payload.
 *
 * `action` finishes the sentence "Could not ..." for the 500 case, so what a
 * person sees still says what failed without saying how.
 */
function jsonRoute(action, work) {
  return async (req, res) => {
    try {
      const payload = await work(req, res);
      if (!res.headersSent) res.json(payload);
    } catch (err) {
      if (err instanceof HttpError) {
        return res.status(err.status).json({
          error: err.message,
          ...(err.code ? { code: err.code } : {}),
          ...(err.details || {}),
        });
      }
      console.error(`Could not ${action}:`, err);
      res.status(500).json({ error: `Could not ${action}.` });
    }
  };
}

module.exports = { HttpError, jsonRoute };
