const db = require("../db");
const media = require("../media");
const Rules = require("../../protected/js/announcements/rules");
const model = require("./model");
const { sanitize, publishProblems } = require("./validate");
const { HttpError } = require("../http-error");

// Every operation behind /api/announcements and the Studio.
//
// Reads pass legacy posts through model.normalize and legacy read state through
// Rules.isRead, so nothing in here - or above it - branches on how old a post
// is.

const nowSeconds = () => Math.floor(Date.now() / 1000);

const EVENTS = new Set(["delivered", "opened", "dismissed", "cta"]);

// The fields whose change, on a live post, earns it an "Updated" label.
const CONTENT_FIELDS = ["title", "summary", "body", "media"];

function idOf(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function notAvailable() {
  return new HttpError(404, "That announcement is not available.", { code: "not_found" });
}

function mediaIdsOf(items) {
  return items.map((a) => a.media && a.media.media_id).filter(Boolean);
}

function pinnedThenNewest(a, b) {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  return (b.publish_at || 0) - (a.publish_at || 0) || b.id - a.id;
}

// ==========================================
// PEOPLE
// ==========================================

async function visibleTo(user) {
  const now = nowSeconds();
  const [raws, receipts] = await Promise.all([
    db.listAnnouncements({ publishedOnly: true }),
    db.getReceiptsForUser(user.id),
  ]);
  return {
    now,
    items: raws
      .map(model.normalize)
      .filter((a) => Rules.isLive(a, now) && Rules.inAudience(a, user)),
    receipts: new Map(receipts.map((r) => [r.announcement_id, r])),
  };
}

async function viewsFor(user, { now, items, receipts }) {
  const [counts, mediaById] = await Promise.all([
    db.reactionCounts(items.map((a) => a.id)),
    media.viewsByIds(mediaIdsOf(items)),
  ]);
  return items.map((a) =>
    model.userView(a, {
      user,
      receipt: receipts.get(a.id),
      now,
      counts: counts.get(a.id),
      mediaById,
    }),
  );
}

async function feed(user) {
  const visible = await visibleTo(user);
  const announcements = (await viewsFor(user, visible)).sort(pinnedThenNewest);
  return {
    announcements,
    unread: announcements.filter((a) => a.unread).length,
    server_time: visible.now,
  };
}

/**
 * The cheap poll: just enough for the app to decide whether the feed is worth
 * fetching again.
 */
async function pulse(user) {
  const { now, items, receipts } = await visibleTo(user);
  let unread = 0;
  let undelivered = 0;
  let latest = 0;
  for (const a of items) {
    if (!Rules.isDeliverable(a, user, now)) continue;
    const receipt = receipts.get(a.id);
    if (!Rules.isRead(a, user, receipt)) unread += 1;
    if (!Rules.wasDelivered(a, user, receipt)) undelivered += 1;
    latest = Math.max(latest, Rules.deliveryAnchor(a));
  }
  return { unread, undelivered, latest_at: latest || null, server_time: now };
}

async function findVisible(user, rawId) {
  const id = idOf(rawId);
  if (!id) return null;
  const a = model.normalize(await db.getAnnouncement(id));
  if (!a || !Rules.isLive(a, nowSeconds()) || !Rules.inAudience(a, user)) return null;
  return a;
}

async function getOne(user, rawId) {
  const a = await findVisible(user, rawId);
  if (!a) return null;
  const receipt = await db.getReceipt(a.id, user.id);
  const [view] = await viewsFor(user, {
    now: nowSeconds(),
    items: [a],
    receipts: new Map(receipt ? [[a.id, receipt]] : []),
  });
  return view;
}

async function recordEvent(user, rawId, event) {
  if (!EVENTS.has(event)) {
    throw new HttpError(400, "Unknown announcement event.", { code: "bad_event" });
  }
  const a = await findVisible(user, rawId);
  if (!a) throw notAvailable();
  await db.recordReceiptEvent(a.id, user.id, a.delivery_version, event, nowSeconds());
  return { recorded: event };
}

async function react(user, rawId, reaction) {
  if (reaction !== null && !Rules.REACTIONS.some((r) => r.id === reaction)) {
    throw new HttpError(400, "Unknown reaction.", { code: "bad_reaction" });
  }
  const a = await findVisible(user, rawId);
  if (!a) throw notAvailable();
  if (!a.reactions_enabled) {
    throw new HttpError(409, "Reactions are turned off for this announcement.", {
      code: "reactions_disabled",
    });
  }
  await db.setReaction(a.id, user.id, reaction, nowSeconds());
  const counts = await db.reactionCounts([a.id]);
  return { reaction, reactions: counts.get(a.id) || {} };
}

async function readAll(user) {
  const { now, items, receipts } = await visibleTo(user);
  const unread = items.filter(
    (a) => Rules.isDeliverable(a, user, now) && !Rules.isRead(a, user, receipts.get(a.id)),
  );
  await Promise.all(
    unread.map((a) => db.recordReceiptEvent(a.id, user.id, a.delivery_version, "opened", now)),
  );
  return { marked: unread.length };
}

// ==========================================
// STUDIO
// ==========================================

function summarize(a, users, receipts) {
  const byUser = new Map(receipts.map((r) => [r.user_id, r]));
  const audience = Rules.audienceOf(a, users);
  let delivered = 0;
  let opened = 0;
  let clicked = 0;
  for (const user of audience) {
    const receipt = byUser.get(user.id);
    if (Rules.wasDelivered(a, user, receipt)) delivered += 1;
    if (Rules.isRead(a, user, receipt)) opened += 1;
    if (Rules.clickedThrough(a, receipt)) clicked += 1;
  }
  // Reactions outlive a redelivery: nobody has to react again because the post
  // was sent twice.
  const reactions = {};
  for (const r of receipts) {
    if (r.reaction) reactions[r.reaction] = (reactions[r.reaction] || 0) + 1;
  }
  return { audience: audience.length, delivered, opened, clicked, reactions };
}

async function adminOne(raw) {
  const a = model.normalize(raw);
  const mediaById = await media.viewsByIds(mediaIdsOf([a]));
  return model.adminView(a, { mediaById, now: nowSeconds() });
}

async function adminList() {
  const now = nowSeconds();
  const [raws, users, receipts] = await Promise.all([
    db.listAnnouncements(),
    db.getAllUsers(),
    db.listReceiptSummaries(),
  ]);
  const items = raws.map(model.normalize);
  const mediaById = await media.viewsByIds(mediaIdsOf(items));

  const byAnnouncement = new Map();
  for (const r of receipts) {
    if (!byAnnouncement.has(r.announcement_id)) byAnnouncement.set(r.announcement_id, []);
    byAnnouncement.get(r.announcement_id).push(r);
  }

  return {
    announcements: items.map((a) => ({
      ...model.adminView(a, { mediaById, now }),
      stats: summarize(a, users, byAnnouncement.get(a.id) || []),
    })),
    server_time: now,
  };
}

async function adminGet(rawId) {
  const id = idOf(rawId);
  const raw = id ? await db.getAnnouncement(id) : null;
  if (!raw) return null;

  const a = model.normalize(raw);
  const now = nowSeconds();
  const [users, receipts, mediaById, receiptsSince] = await Promise.all([
    db.getAllUsers(),
    db.getReceiptsForAnnouncement(id),
    media.viewsByIds(mediaIdsOf([a])),
    db.earliestReceiptAt(),
  ]);

  const byUser = new Map(receipts.map((r) => [r.user_id, r]));
  const current = (receipt, field) =>
    receipt && receipt[field] && (receipt.version || 0) >= a.delivery_version
      ? receipt[field]
      : null;

  const people = Rules.audienceOf(a, users).map((user) => {
    const receipt = byUser.get(user.id);
    const opened = Rules.isRead(a, user, receipt);
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      delivered: Rules.wasDelivered(a, user, receipt),
      opened,
      // Read according to the old watermark, which never recorded when.
      opened_by_watermark: opened && !current(receipt, "opened_at"),
      delivered_at: current(receipt, "delivered_at"),
      opened_at: current(receipt, "opened_at"),
      dismissed_at: current(receipt, "dismissed_at"),
      clicked_at: current(receipt, "cta_at"),
      reaction: (receipt && receipt.reaction) || null,
    };
  });

  return {
    announcement: model.adminView(a, { mediaById, now }),
    stats: { ...summarize(a, users, receipts), people, receipts_since: receiptsSince },
    server_time: now,
  };
}

async function preview(user, rawId) {
  const id = idOf(rawId);
  const a = id ? model.normalize(await db.getAnnouncement(id)) : null;
  if (!a) return null;

  const now = nowSeconds();
  const [counts, mediaById] = await Promise.all([
    db.reactionCounts([a.id]),
    media.viewsByIds(mediaIdsOf([a])),
  ]);
  // Played as fresh news whatever the post's real state, because what an admin
  // previews is its arrival - not a quiet row in an inbox.
  const asNews = {
    ...a,
    status: "published",
    publish_at: Math.min(a.publish_at || now, now),
    expires_at: null,
    evergreen: true,
    audience: { type: "everyone", user_ids: [] },
  };
  return {
    ...model.userView(asNews, { user, receipt: null, now, counts: counts.get(a.id), mediaById }),
    preview: true,
  };
}

function refsOf(fields) {
  const refs = new Set(media.refsIn(fields.body));
  if (fields.media && fields.media.media_id) refs.add(fields.media.media_id);
  return [...refs];
}

async function create(admin, input) {
  const fields = sanitize(input);
  const now = nowSeconds();
  const doc = {
    id: await db.nextAnnouncementId(),
    ...fields,
    media_refs: refsOf(fields),
    status: "draft",
    published_at: null,
    redelivered_at: null,
    content_updated_at: null,
    delivery_version: 1,
    revision: 1,
    created_by: admin.id,
    created_at: now,
    updated_by: admin.id,
    updated_at: now,
  };
  await db.insertAnnouncement(doc);
  return adminOne(doc);
}

async function loadForWrite(rawId) {
  const id = idOf(rawId);
  const raw = id ? await db.getAnnouncement(id) : null;
  if (!raw) throw new HttpError(404, "Announcement not found.", { code: "not_found" });
  return { raw, current: model.normalize(raw) };
}

function revisionOf(body) {
  const revision = Number(body.revision);
  if (!Number.isInteger(revision) || revision < 1) {
    throw new HttpError(400, "Say which revision of the announcement you are changing.", {
      code: "revision_required",
    });
  }
  return revision;
}

/**
 * Write through the revision check, or say whose change got there first.
 *
 * A conflict carries the stored post, so the Studio can offer to load it rather
 * than only refusing.
 */
async function writeChecked(current, revision, change) {
  const updated = await db.updateAnnouncementIfRevision(current.id, revision, change);
  if (updated) return adminOne(updated);

  const latest = await db.getAnnouncement(current.id);
  if (!latest) throw new HttpError(404, "Announcement not found.", { code: "not_found" });
  throw new HttpError(409, "This announcement was changed somewhere else after you opened it.", {
    code: "revision_conflict",
    details: { announcement: await adminOne(latest) },
  });
}

// A legacy post saved from the Studio becomes a current one: what its absent
// status implied is written down, and the old fields go.
function legacyChange(raw, current) {
  if (!model.isLegacy(raw)) return { set: {}, unset: {} };
  return {
    set: {
      status: current.status,
      publish_at: current.publish_at,
      published_at: current.published_at,
      delivery_version: current.delivery_version,
    },
    unset: model.LEGACY_FIELDS,
  };
}

async function update(admin, rawId, body) {
  const revision = revisionOf(body);
  const { raw, current } = await loadForWrite(rawId);
  const fields = sanitize(body);
  const now = nowSeconds();
  const status = Rules.studioStatus(current, now);
  const legacy = legacyChange(raw, current);

  const set = {
    ...fields,
    media_refs: refsOf(fields),
    ...legacy.set,
    updated_by: admin.id,
    updated_at: now,
  };

  // Once a post is out, when it went out is history - it decided who got it.
  // Only a draft, or a post still waiting for its moment, can be rescheduled,
  // and a scheduled post keeps its slot unless it is given a new future one.
  if (status === "scheduled") {
    if (fields.publish_at == null || fields.publish_at <= now) set.publish_at = current.publish_at;
  } else if (status !== "draft") {
    set.publish_at = current.publish_at;
  }

  if (
    status === "live" &&
    CONTENT_FIELDS.some((f) => JSON.stringify(fields[f]) !== JSON.stringify(current[f]))
  ) {
    set.content_updated_at = now;
  }

  return writeChecked(current, revision, { set, unset: legacy.unset });
}

async function publish(admin, rawId, body) {
  const revision = revisionOf(body);
  const { raw, current } = await loadForWrite(rawId);
  const now = nowSeconds();

  if (Rules.studioStatus(current, now) === "live") {
    throw new HttpError(409, "It is already live.", { code: "already_live" });
  }

  // An explicit time wins; otherwise a draft keeps the slot it was given, and
  // anything already in the past means now.
  const requested = body.publish_at != null ? Number(body.publish_at) : current.status === "draft" ? current.publish_at : null;
  const publishAt = Number.isInteger(requested) && requested > now ? requested : now;

  const [file, users] = await Promise.all([
    current.media && current.media.media_id ? db.getMedia(current.media.media_id) : null,
    current.audience.type === "users" ? db.getAllUsers() : [],
  ]);
  const problems = publishProblems(current, {
    file,
    userIds: new Set(users.map((u) => u.id)),
    publishAt,
  });
  if (problems.length) {
    throw new HttpError(422, problems[0].message, { code: "not_ready", details: { problems } });
  }

  const legacy = legacyChange(raw, current);
  return writeChecked(current, revision, {
    set: {
      ...legacy.set,
      status: "published",
      publish_at: publishAt,
      published_at: current.published_at || now,
      updated_by: admin.id,
      updated_at: now,
    },
    unset: legacy.unset,
  });
}

async function unpublish(admin, rawId, body) {
  const revision = revisionOf(body);
  const { raw, current } = await loadForWrite(rawId);
  const now = nowSeconds();
  const legacy = legacyChange(raw, current);
  return writeChecked(current, revision, {
    set: {
      ...legacy.set,
      status: "draft",
      // A scheduled post that is pulled back keeps its planned slot as a draft;
      // one that had already gone out has no future slot to keep.
      publish_at: current.publish_at != null && current.publish_at > now ? current.publish_at : null,
      updated_by: admin.id,
      updated_at: now,
    },
    unset: legacy.unset,
  });
}

async function archive(admin, rawId, body) {
  const revision = revisionOf(body);
  const { raw, current } = await loadForWrite(rawId);
  const legacy = legacyChange(raw, current);
  return writeChecked(current, revision, {
    set: { ...legacy.set, status: "archived", updated_by: admin.id, updated_at: nowSeconds() },
    unset: legacy.unset,
  });
}

/**
 * "Notify again": everyone in the audience gets the post as news once more,
 * including people who joined since it first went out.
 */
async function redeliver(admin, rawId, body) {
  const revision = revisionOf(body);
  const { raw, current } = await loadForWrite(rawId);
  const now = nowSeconds();
  if (Rules.studioStatus(current, now) !== "live") {
    throw new HttpError(409, "Only a live announcement can be sent again.", { code: "not_live" });
  }
  const legacy = legacyChange(raw, current);
  return writeChecked(current, revision, {
    set: {
      ...legacy.set,
      redelivered_at: now,
      delivery_version: current.delivery_version + 1,
      updated_by: admin.id,
      updated_at: now,
    },
    unset: legacy.unset,
  });
}

async function duplicate(admin, rawId) {
  const { current } = await loadForWrite(rawId);
  return create(admin, {
    ...current,
    title: current.title ? `Copy of ${current.title}`.slice(0, 90) : "",
    publish_at: null,
    expires_at: null,
  });
}

async function remove(rawId) {
  const id = idOf(rawId);
  if (!id || !(await db.deleteAnnouncement(id))) {
    throw new HttpError(404, "Announcement not found.", { code: "not_found" });
  }
}

module.exports = {
  feed,
  pulse,
  getOne,
  recordEvent,
  react,
  readAll,
  adminList,
  adminGet,
  preview,
  create,
  update,
  publish,
  unpublish,
  archive,
  redeliver,
  duplicate,
  remove,
};
