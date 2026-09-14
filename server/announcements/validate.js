const Rules = require("../../protected/js/announcements/rules");
const Scenes = require("../../protected/js/motion/scenes");
const { HttpError } = require("../http-error");

// Everything the Studio can send, reduced to what an announcement may hold.
//
// Two levels, because a draft is allowed to be half-written. sanitize() runs on
// every save and refuses only what could never be valid - the wrong type, text
// past its limit, an unsafe link. publishProblems() is the checklist that has to
// be clear before a post goes out to anyone.

const LIMITS = {
  title: 90,
  summary: 160,
  body: 20000,
  alt: 200,
  ctaLabel: 32,
  url: 500,
  audience: 1000,
};

const UPLOAD_TYPES = ["image", "animated_image", "svg", "video", "lottie"];
const HEX = /^#[0-9a-f]{6}$/i;
const MEDIA_ID = /^med_[a-f0-9]{16}$/;
const USER_ID = /^usr_[a-f0-9]{12}$/;

// Wide enough for any real schedule, narrow enough to catch milliseconds sent
// where seconds belong.
const EARLIEST = Date.UTC(2020, 0, 1) / 1000;
const LATEST = Date.UTC(2100, 0, 1) / 1000;

function invalid(message, field) {
  return new HttpError(400, message, { code: "invalid", details: { field } });
}

function text(value, max, field, label) {
  if (value == null) return "";
  if (typeof value !== "string") throw invalid(`${label} must be text.`, field);
  const clean = value.replace(/\r\n?/g, "\n");
  if (clean.length > max) throw invalid(`${label} can be up to ${max} characters.`, field);
  return clean;
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function fraction(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

function timestamp(value, field, label) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < EARLIEST || n > LATEST) {
    throw invalid(`${label} is not a valid date.`, field);
  }
  return n;
}

function isSafeLink(url) {
  try {
    return ["https:", "http:", "mailto:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

function sanitizeMedia(input) {
  if (input == null) return null;
  if (typeof input !== "object") throw invalid("The header is in a format klndr does not understand.", "media");

  const framing = {
    alt: text(input.alt, LIMITS.alt, "media.alt", "Alt text").trim(),
    decorative: Boolean(input.decorative),
    fit: oneOf(input.fit, ["cover", "contain"], "cover"),
    aspect: oneOf(input.aspect, Object.keys(Rules.ASPECTS), "2:1"),
    focal: {
      x: fraction(input.focal && input.focal.x, 0.5),
      y: fraction(input.focal && input.focal.y, 0.5),
    },
    background: HEX.test(input.background || "") ? input.background.toLowerCase() : null,
  };

  if (input.type === "scene") {
    const id = input.scene && input.scene.id;
    if (!Scenes.get(id)) throw invalid("Pick a motion scene from the gallery.", "media.scene");
    return {
      type: "scene",
      ...framing,
      scene: { id, props: Scenes.sanitizeProps(id, input.scene.props) },
    };
  }

  if (UPLOAD_TYPES.includes(input.type)) {
    // A post from before the media library can point at a plain image URL. It
    // keeps it; nothing new is created that way.
    if (input.type === "image" && !input.media_id && typeof input.url === "string") {
      if (!/^https:\/\//i.test(input.url) || input.url.length > LIMITS.url) {
        throw invalid("The header image link has to be https.", "media.url");
      }
      return { type: "image", ...framing, url: input.url };
    }
    if (typeof input.media_id !== "string" || !MEDIA_ID.test(input.media_id)) {
      throw invalid("The header file is missing. Upload it again.", "media.media_id");
    }
    return {
      type: input.type,
      ...framing,
      media_id: input.media_id,
      ...(input.type === "video" ? { has_audio: Boolean(input.has_audio) } : {}),
    };
  }

  throw invalid("That kind of header is not supported.", "media.type");
}

function sanitizeCta(input) {
  if (input == null) return null;
  if (typeof input !== "object") throw invalid("The button is in a format klndr does not understand.", "cta");

  const label = text(input.label, LIMITS.ctaLabel, "cta.label", "The button label").trim();
  const url = typeof input.url === "string" ? input.url.trim() : "";
  const action = typeof input.app_action === "string" ? input.app_action : "";
  if (!label && !url && !action) return null;

  if (action) {
    if (!Rules.APP_ACTIONS.some((a) => a.id === action)) {
      throw invalid("That klndr screen does not exist.", "cta.app_action");
    }
    return { label, app_action: action };
  }
  if (url) {
    if (url.length > LIMITS.url || !isSafeLink(url)) {
      throw invalid("Button links have to start with https://, http:// or mailto:.", "cta.url");
    }
    return { label, url };
  }
  // Half-written: a label with nowhere to go yet. Fine for a draft; publishing
  // says so.
  return { label };
}

function sanitizeAudience(input) {
  const type = oneOf(input && input.type, Rules.AUDIENCES.map((a) => a.id), "everyone");
  if (type !== "users") return { type, user_ids: [] };
  const ids = Array.isArray(input.user_ids) ? input.user_ids : [];
  return {
    type,
    user_ids: [...new Set(ids.filter((id) => typeof id === "string" && USER_ID.test(id)))].slice(
      0,
      LIMITS.audience,
    ),
  };
}

function sanitize(input = {}) {
  return {
    title: text(input.title, LIMITS.title, "title", "The title").trim(),
    summary: text(input.summary, LIMITS.summary, "summary", "The summary").trim(),
    body: text(input.body, LIMITS.body, "body", "The body"),
    body_format: oneOf(input.body_format, ["md", "legacy"], "md"),
    kind: oneOf(input.kind, Rules.KINDS.map((k) => k.id), "feature"),
    media: sanitizeMedia(input.media),
    cta: sanitizeCta(input.cta),
    delivery: oneOf(input.delivery, Rules.DELIVERIES.map((d) => d.id), "story"),
    audience: sanitizeAudience(input.audience),
    evergreen: Boolean(input.evergreen),
    pinned: Boolean(input.pinned),
    reactions_enabled: input.reactions_enabled !== false,
    publish_at: timestamp(input.publish_at, "publish_at", "The publish date"),
    expires_at: timestamp(input.expires_at, "expires_at", "The expiry date"),
  };
}

/**
 * What stands between a post and publishing, as { field, message } pairs.
 *
 * `file` is the header's library row when the header is an upload, `userIds`
 * every account that exists, and `publishAt` when the post would go out.
 */
function publishProblems(a, { file, userIds, publishAt }) {
  const problems = [];
  const add = (field, message) => problems.push({ field, message });

  if (!a.title.trim()) add("title", "Give it a title.");

  const media = a.media;
  if (media && UPLOAD_TYPES.includes(media.type) && media.media_id) {
    if (!file) add("media", "The header file is missing from the library. Upload it again.");
    else if (file.status !== "ready") add("media", "The header has not finished uploading.");
    else if (file.kind !== media.type) add("media", "The header file does not match its type. Upload it again.");
    if (!media.decorative && !media.alt) {
      add("media.alt", "Describe the header for anyone who cannot see it, or mark it decorative.");
    }
  }

  if (a.cta) {
    if (!a.cta.label) add("cta.label", "The button needs a label.");
    if (!a.cta.url && !a.cta.app_action) add("cta", "The button needs somewhere to go.");
  }

  if (a.audience.type === "users") {
    if (!a.audience.user_ids.length) add("audience", "Choose at least one person.");
    else if (a.audience.user_ids.some((id) => !userIds.has(id))) {
      add("audience", "Some of the people chosen no longer have accounts.");
    }
  }

  if (a.expires_at != null && a.expires_at <= publishAt) {
    add("expires_at", "It would expire before it goes out.");
  }

  return problems;
}

module.exports = { LIMITS, sanitize, publishProblems, isSafeLink };
