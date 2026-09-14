const express = require("express");
const service = require("../announcements/service");
const { HttpError, jsonRoute } = require("../http-error");

// What a signed-in person can do with announcements. Mounted at
// /api/announcements behind requireApiAuth in server.js.
//
// Every read and write is scoped to req.user inside the service. No URL here
// names a person, so there is no way to read or mark somebody else's receipts.

const router = express.Router();

// Per person, and it changes by the minute. Nothing between here and the
// browser gets to keep a copy.
router.use((req, res, next) => {
  res.set("Cache-Control", "private, no-store");
  next();
});

router.get("/feed", jsonRoute("load announcements", (req) => service.feed(req.user)));

router.get("/pulse", jsonRoute("check for announcements", (req) => service.pulse(req.user)));

router.post(
  "/read-all",
  jsonRoute("mark announcements read", (req) => service.readAll(req.user)),
);

router.get(
  "/:id",
  jsonRoute("load the announcement", async (req) => {
    const announcement = await service.getOne(req.user, req.params.id);
    if (!announcement) throw new HttpError(404, "That announcement is not available.");
    return { announcement };
  }),
);

router.post(
  "/:id/receipts",
  jsonRoute("record that", (req) =>
    service.recordEvent(req.user, req.params.id, req.body && req.body.event),
  ),
);

router.put(
  "/:id/reaction",
  jsonRoute("save your reaction", (req) =>
    service.react(req.user, req.params.id, req.body ? (req.body.reaction ?? null) : null),
  ),
);

module.exports = router;
