const Rules = require("../../protected/js/announcements/rules");

// The shape an announcement has in memory, whatever shape it was stored in.
//
// Posts written before this rewrite carry `content` and `header_image_url` and
// no status at all. They are not migrated. They are read as what they always
// were - published the moment they were created, delivered as a story, to
// everyone - and they take the new shape the first time someone saves them from
// the Studio. The same principle TaskModel.ensureSegments applies on the client.

// The legacy fields a Studio save leaves behind.
const LEGACY_FIELDS = { content: "", header_image_url: "" };

// An edit is only labelled "Updated" once the post has been out for a while.
// Fixing a typo a minute after publishing should not stamp that on something
// hardly anyone has read yet.
const UPDATE_GRACE_SECONDS = 10 * 60;

function isLegacy(raw) {
  return raw.status === undefined;
}

// The old schema had a header image field that the old UI never set. Honoured
// anyway, in case a script ever did.
function legacyMedia(raw) {
  if (!raw.header_image_url) return null;
  return {
    type: "image",
    url: raw.header_image_url,
    alt: "",
    decorative: true,
    fit: "cover",
    aspect: "2:1",
    focal: { x: 0.5, y: 0.5 },
    background: null,
  };
}

function normalize(raw) {
  if (!raw) return null;
  const legacy = isLegacy(raw);
  return {
    id: raw.id,
    legacy,
    title: raw.title || "",
    summary: raw.summary || "",
    body: legacy ? raw.content || "" : raw.body || "",
    body_format: legacy ? "legacy" : raw.body_format || "md",
    kind: raw.kind || (legacy ? "news" : "feature"),
    media: raw.media || legacyMedia(raw),
    cta: raw.cta || null,
    delivery: raw.delivery || "story",
    audience: raw.audience || { type: "everyone", user_ids: [] },
    evergreen: Boolean(raw.evergreen),
    pinned: Boolean(raw.pinned),
    reactions_enabled: raw.reactions_enabled !== false,
    status: legacy ? "published" : raw.status,
    publish_at: legacy ? raw.created_at : (raw.publish_at ?? null),
    expires_at: raw.expires_at ?? null,
    published_at: legacy ? raw.created_at : (raw.published_at ?? null),
    redelivered_at: raw.redelivered_at ?? null,
    content_updated_at: raw.content_updated_at ?? null,
    delivery_version: raw.delivery_version || 1,
    revision: raw.revision || 1,
    media_refs: raw.media_refs || [],
    created_by: raw.created_by || null,
    created_at: raw.created_at || null,
    updated_by: raw.updated_by || raw.created_by || null,
    updated_at: raw.updated_at || raw.created_at || null,
  };
}

/**
 * The header as a viewer needs it: framing from the post, the file's address
 * and dimensions from the library.
 *
 * Null when the file is missing or unfinished, so a broken upload shows no
 * header at all rather than a broken image.
 */
function resolveMedia(media, mediaById) {
  if (!media) return null;
  const framing = {
    type: media.type,
    alt: media.alt || "",
    decorative: Boolean(media.decorative),
    fit: media.fit || "cover",
    aspect: media.aspect || "2:1",
    focal: media.focal || { x: 0.5, y: 0.5 },
    background: media.background || null,
  };
  if (media.type === "scene") return { ...framing, scene: media.scene };
  if (media.url) return { ...framing, url: media.url };

  const file = mediaById.get(media.media_id);
  if (!file || file.status !== "ready" || !file.url) return null;
  return {
    ...framing,
    media_id: file.id,
    url: file.url,
    poster_url: file.poster_url,
    width: file.width,
    height: file.height,
    duration_ms: file.duration_ms,
    has_audio: media.type === "video" && Boolean(media.has_audio),
  };
}

function updatedLabel(a) {
  if (!a.content_updated_at || a.publish_at == null) return null;
  return a.content_updated_at > a.publish_at + UPDATE_GRACE_SECONDS
    ? a.content_updated_at
    : null;
}

/**
 * One post as one person sees it. Leaves out everything that is the Studio's
 * business - who else it is for, who wrote it, its revision.
 */
function userView(a, { user, receipt, now, counts, mediaById }) {
  const deliverable = Rules.isDeliverable(a, user, now);
  const read = Rules.isRead(a, user, receipt);
  return {
    id: a.id,
    title: a.title,
    summary: a.summary,
    body: a.body,
    body_format: a.body_format,
    kind: a.kind,
    media: resolveMedia(a.media, mediaById),
    cta: a.cta,
    delivery: a.delivery,
    pinned: a.pinned,
    reactions_enabled: a.reactions_enabled,
    publish_at: a.publish_at,
    expires_at: a.expires_at,
    updated_at: updatedLabel(a),
    // A post from before someone joined is part of the history they can
    // browse, not news: it reads as read and never interrupts.
    deliverable,
    read: !deliverable || read,
    unread: deliverable && !read,
    delivered: !deliverable || Rules.wasDelivered(a, user, receipt),
    reaction: (receipt && receipt.reaction) || null,
    reactions: counts || {},
  };
}

function adminView(a, { mediaById, now }) {
  const file = a.media && a.media.media_id ? mediaById.get(a.media.media_id) : null;
  return {
    ...a,
    studio_status: Rules.studioStatus(a, now),
    updated_label_at: updatedLabel(a),
    media_resolved: resolveMedia(a.media, mediaById),
    media_file: file || null,
  };
}

module.exports = {
  LEGACY_FIELDS,
  isLegacy,
  normalize,
  resolveMedia,
  userView,
  adminView,
};
