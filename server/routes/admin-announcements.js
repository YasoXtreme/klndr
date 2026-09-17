const express = require("express");
const service = require("../announcements/service");
const { HttpError, jsonRoute } = require("../http-error");

// The Studio's API. Mounted at /api/admin/announcements with requireApiAuth and
// requireAdmin on the mount, like analytics: every route is admin-only JSON.

const router = express.Router();

router.use((req, res, next) => {
  res.set("Cache-Control", "private, no-store");
  next();
});

router.get("/", jsonRoute("list announcements", () => service.adminList()));

router.post(
  "/",
  jsonRoute("create the announcement", async (req) => ({
    announcement: await service.create(req.user, req.body || {}),
  })),
);

router.get(
  "/:id",
  jsonRoute("load the announcement", async (req) => {
    const result = await service.adminGet(req.params.id);
    if (!result) throw new HttpError(404, "Announcement not found.");
    return result;
  }),
);

// What the app plays for "Preview in app": the post exactly as a person would
// get it, whatever its status and whoever it is for.
router.get(
  "/:id/preview",
  jsonRoute("preview the announcement", async (req) => {
    const announcement = await service.preview(req.user, req.params.id);
    if (!announcement) throw new HttpError(404, "Announcement not found.");
    return { announcement };
  }),
);

router.put(
  "/:id",
  jsonRoute("save the announcement", async (req) => ({
    announcement: await service.update(req.user, req.params.id, req.body || {}),
  })),
);

// Every status change takes the revision the Studio last saw, so nobody
// publishes a version of the post they have not looked at.
const TRANSITIONS = {
  publish: "publish the announcement",
  unpublish: "move the announcement back to drafts",
  archive: "archive the announcement",
  redeliver: "send the announcement again",
  duplicate: "duplicate the announcement",
};

for (const [name, action] of Object.entries(TRANSITIONS)) {
  router.post(
    `/:id/${name}`,
    jsonRoute(action, async (req) => ({
      announcement: await service[name](req.user, req.params.id, req.body || {}),
    })),
  );
}

router.delete(
  "/:id",
  jsonRoute("delete the announcement", async (req) => {
    await service.remove(req.params.id);
    return { deleted: true };
  }),
);

module.exports = router;
