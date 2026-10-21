const express = require("express");
const media = require("../media");
const { jsonRoute } = require("../http-error");

// The Studio's media library. Mounted at /api/admin/media with requireApiAuth
// and requireAdmin on the mount, like analytics: every route is admin-only JSON.
//
// No route here ever receives file bytes. An upload is signed here, sent by the
// browser straight to R2, and confirmed here - see server/media.js.

const router = express.Router();

router.use((req, res, next) => {
  res.set("Cache-Control", "private, no-store");
  next();
});

router.get("/status", jsonRoute("check media storage", () => media.status()));

router.get(
  "/",
  jsonRoute("load the media library", async () => ({ media: await media.listLibrary() })),
);

router.post(
  "/uploads",
  jsonRoute("start the upload", (req) => media.createUpload(req.user.id, req.body || {})),
);

router.post(
  "/:id/complete",
  jsonRoute("finish the upload", async (req) => ({
    media: await media.completeUpload(req.params.id),
  })),
);

router.delete(
  "/:id",
  jsonRoute("delete the file", async (req) => {
    await media.deleteMedia(req.params.id);
    return { deleted: true };
  }),
);

module.exports = router;
