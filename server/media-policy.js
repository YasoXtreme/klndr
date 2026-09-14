const { HttpError } = require("./http-error");

// What may go into the media library, and how an uploaded document is checked.
//
// Pure: no bucket, no database. server/media.js does the I/O and asks this file
// every question, which is what lets test/media.test.js cover the rules without
// either of them.

const MB = 1024 * 1024;

const KINDS = {
  image: {
    label: "Image",
    maxBytes: 10 * MB,
    types: { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/avif": "avif" },
  },
  // GIF, APNG and animated WebP. The browser decides whether a PNG or WebP is
  // animated by looking inside it; all that changes here is the ceiling.
  animated_image: {
    label: "Animated image",
    maxBytes: 20 * MB,
    types: { "image/gif": "gif", "image/png": "png", "image/webp": "webp" },
  },
  svg: { label: "SVG", maxBytes: 2 * MB, types: { "image/svg+xml": "svg" } },
  video: {
    label: "Video",
    maxBytes: 50 * MB,
    types: { "video/mp4": "mp4", "video/webm": "webm" },
  },
  // .lottie archives are unzipped in the browser and arrive here as the JSON
  // inside them, so there is one format to validate and one to play.
  lottie: { label: "Lottie", maxBytes: 5 * MB, types: { "application/json": "json" } },
};

// The still frame shown before a video or animation plays, and instead of it for
// anyone who has asked for reduced motion. Always captured in the browser.
const POSTER = { contentType: "image/webp", ext: "webp", maxBytes: 2 * MB };

// A key is never reused - replacing a file is a new upload with a new id - so
// nothing ever needs purging from a cache, and every object can say forever.
const CACHE_CONTROL = "public, max-age=31536000, immutable";

// A pending row older than this is an upload that never finished: a closed tab,
// a dropped connection.
const PENDING_TTL_SECONDS = 24 * 60 * 60;

// Object keys embed the media id. That is how an image written into a post's
// body as a plain URL still counts as a use of the file.
const REF_PATTERN = /announcements\/\d{4}\/\d{2}\/(med_[a-f0-9]{16})\//g;

function baseType(contentType) {
  return String(contentType || "").split(";")[0].trim().toLowerCase();
}

function wholeNumber(value, max) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n <= max ? Math.round(n) : null;
}

/**
 * Check what the browser says it is about to upload, and return it tidied.
 * Throws the HttpError a person should see when it is not allowed.
 */
function checkUpload(input = {}) {
  const spec = KINDS[input.kind];
  if (!spec) throw new HttpError(400, "That kind of file is not supported.", { code: "bad_kind" });

  const contentType = baseType(input.content_type);
  const ext = spec.types[contentType];
  if (!ext) {
    throw new HttpError(
      400,
      `${spec.label} uploads must be one of: ${Object.keys(spec.types).join(", ")}.`,
      { code: "bad_type" },
    );
  }

  const bytes = Number(input.bytes);
  if (!Number.isInteger(bytes) || bytes <= 0) {
    throw new HttpError(400, "The file's size is missing.", { code: "bad_size" });
  }
  if (bytes > spec.maxBytes) {
    throw new HttpError(413, `${spec.label} files can be up to ${spec.maxBytes / MB} MB.`, {
      code: "too_large",
    });
  }

  let posterBytes = null;
  if (input.poster) {
    posterBytes = Number(input.poster.bytes);
    if (!Number.isInteger(posterBytes) || posterBytes <= 0 || posterBytes > POSTER.maxBytes) {
      throw new HttpError(400, "The poster frame is too large.", { code: "bad_poster" });
    }
  }

  return {
    kind: input.kind,
    contentType,
    ext,
    bytes,
    posterBytes,
    filename: String(input.filename || "").slice(0, 160),
    width: wholeNumber(input.width, 20000),
    height: wholeNumber(input.height, 20000),
    duration_ms: wholeNumber(input.duration_ms, 60 * 60 * 1000),
  };
}

function slugify(filename) {
  const slug = String(filename || "")
    .replace(/\.[^.]*$/, "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036F]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "file";
}

function keysFor(id, filename, ext, now) {
  const at = new Date(now * 1000);
  const month = String(at.getUTCMonth() + 1).padStart(2, "0");
  const folder = `announcements/${at.getUTCFullYear()}/${month}/${id}`;
  return {
    key: `${folder}/${slugify(filename)}.${ext}`,
    posterKey: `${folder}/poster.${POSTER.ext}`,
  };
}

function refsIn(text) {
  const ids = new Set();
  for (const match of String(text || "").matchAll(REF_PATTERN)) ids.add(match[1]);
  return [...ids];
}

/**
 * What is wrong with an SVG, as a list of reasons. Empty means fine.
 *
 * klndr only ever draws an uploaded SVG through <img>, where scripts never run,
 * so none of this protects the app. It protects the file's own URL: someone who
 * opens it directly gets a document, and a document can run code. Refusing
 * anything with behaviour in it is simpler than reasoning about which origin
 * that code would run on.
 */
function inspectSvg(text) {
  const source = String(text || "");
  const problems = [];
  if (!/<svg[\s>]/i.test(source)) problems.push("it is not an SVG document");
  if (/<script[\s>]/i.test(source)) problems.push("it contains a script");
  if (/\son[a-z]+\s*=/i.test(source)) problems.push("it contains an event handler");
  if (/javascript\s*:/i.test(source)) problems.push("it contains a javascript: link");
  if (/<foreignObject[\s>]/i.test(source)) problems.push("it embeds HTML");
  if (/<(?:iframe|embed|object)[\s>]/i.test(source)) problems.push("it embeds another document");
  if (/<!ENTITY/i.test(source)) problems.push("it declares an XML entity");
  if (
    /\s(?:xlink:)?href\s*=\s*["']\s*(?:https?:)?\/\//i.test(source) ||
    /url\(\s*["']?\s*(?:https?:)?\/\//i.test(source) ||
    /@import/i.test(source)
  ) {
    problems.push("it loads something from elsewhere");
  }
  return problems;
}

/**
 * Checks the structure every Lottie player needs, and reads the dimensions and
 * length out of it.
 *
 * Expressions are not looked for, on purpose: klndr plays Lottie with
 * lottie-web's light build, which has no expression support at all, so an
 * expression in a file is inert rather than dangerous.
 */
function inspectLottie(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { problems: ["it is not valid JSON"] };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { problems: ["it is not a Lottie animation"] };
  }

  const problems = [];
  for (const field of ["fr", "ip", "op", "w", "h"]) {
    if (typeof data[field] !== "number" || !Number.isFinite(data[field])) {
      problems.push(`it has no "${field}"`);
    }
  }
  if (!Array.isArray(data.layers)) problems.push('it has no "layers"');
  if (problems.length) return { problems };

  const frames = Math.max(0, data.op - data.ip);
  return {
    problems,
    width: Math.round(data.w),
    height: Math.round(data.h),
    duration_ms: data.fr > 0 ? Math.round((frames / data.fr) * 1000) : null,
  };
}

module.exports = {
  MB,
  KINDS,
  POSTER,
  CACHE_CONTROL,
  PENDING_TTL_SECONDS,
  baseType,
  checkUpload,
  slugify,
  keysFor,
  refsIn,
  inspectSvg,
  inspectLottie,
};
