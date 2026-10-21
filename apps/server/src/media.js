const crypto = require("crypto");
const db = require("./db");
const r2 = require("./storage/r2");
const policy = require("./media-policy");
const { HttpError } = require("./http-error");

// The media library: every file uploaded for an announcement.
//
// An upload is three requests, and only the middle one carries bytes:
//
//   1. createUpload    checks what the browser SAYS it has, writes a pending
//                      row, and signs PUT URLs for the file and its poster
//   2. (the browser)   PUTs both straight to R2
//   3. completeUpload  looks at what actually arrived, and only then marks the
//                      row ready
//
// Step 3 is not redundant with the signature. The signature binds the size and
// type the browser claimed; HEAD confirms R2 stored exactly that, and SVG and
// Lottie are read and checked, because those two are documents that can carry
// behaviour rather than just pixels. The rules themselves are media-policy.js.

const nowSeconds = () => Math.floor(Date.now() / 1000);

function requireStorage() {
  if (!r2.isConfigured()) {
    throw new HttpError(
      503,
      "Media storage is not set up yet. Add the R2 settings to the server's environment (see the README).",
      { code: "storage_not_configured" },
    );
  }
}

function status() {
  const configured = r2.isConfigured();
  return {
    configured,
    mode: configured ? r2.mode() : null,
    limits: Object.fromEntries(
      Object.entries(policy.KINDS).map(([kind, spec]) => [
        kind,
        { label: spec.label, max_bytes: spec.maxBytes, types: Object.keys(spec.types) },
      ]),
    ),
    poster: { content_type: policy.POSTER.contentType, max_bytes: policy.POSTER.maxBytes },
  };
}

function view(doc) {
  if (!doc) return null;
  const configured = r2.isConfigured();
  return {
    id: doc.id,
    kind: doc.kind,
    content_type: doc.content_type,
    bytes: doc.bytes,
    original_name: doc.original_name,
    width: doc.width || null,
    height: doc.height || null,
    duration_ms: doc.duration_ms || null,
    status: doc.status,
    created_at: doc.created_at,
    url: configured ? r2.publicUrl(doc.key) : null,
    poster_url: configured && doc.poster_key ? r2.publicUrl(doc.poster_key) : null,
  };
}

async function createUpload(adminId, input) {
  requireStorage();
  const upload = policy.checkUpload(input);

  const now = nowSeconds();
  const id = "med_" + crypto.randomBytes(8).toString("hex");
  const { key, posterKey } = policy.keysFor(id, upload.filename, upload.ext, now);
  const doc = {
    id,
    kind: upload.kind,
    key,
    content_type: upload.contentType,
    bytes: upload.bytes,
    original_name: upload.filename,
    width: upload.width,
    height: upload.height,
    duration_ms: upload.duration_ms,
    poster_key: upload.posterBytes ? posterKey : null,
    poster_bytes: upload.posterBytes,
    status: "pending",
    created_by: adminId,
    created_at: now,
  };
  await db.insertMedia(doc);

  const [fileUrl, posterUrl] = await Promise.all([
    r2.presignPut(key, {
      contentType: upload.contentType,
      contentLength: upload.bytes,
      cacheControl: policy.CACHE_CONTROL,
    }),
    upload.posterBytes
      ? r2.presignPut(posterKey, {
          contentType: policy.POSTER.contentType,
          contentLength: upload.posterBytes,
          cacheControl: policy.CACHE_CONTROL,
        })
      : null,
  ]);

  return { media: view(doc), upload: fileUrl, poster_upload: posterUrl };
}

async function discard(doc) {
  await Promise.allSettled([
    r2.remove(doc.key),
    doc.poster_key ? r2.remove(doc.poster_key) : null,
  ]);
  await db.deleteMedia(doc.id);
}

async function completeUpload(id) {
  requireStorage();

  const doc = await db.getMedia(id);
  if (!doc) throw new HttpError(404, "That upload does not exist.", { code: "not_found" });
  if (doc.status === "ready") return view(doc);

  const stored = await r2.head(doc.key);
  if (!stored) {
    throw new HttpError(409, "The file never arrived. Try uploading it again.", {
      code: "missing_object",
    });
  }
  if (stored.bytes !== doc.bytes || policy.baseType(stored.contentType) !== doc.content_type) {
    await discard(doc);
    throw new HttpError(422, "The stored file did not match what was uploaded. Try again.", {
      code: "mismatch",
    });
  }

  const patch = { status: "ready", ready_at: nowSeconds() };

  // A poster is a nicety. One that never arrived downgrades the file to "no
  // poster" rather than failing an upload whose real content is fine.
  if (doc.poster_key && !(await r2.head(doc.poster_key))) {
    patch.poster_key = null;
    patch.poster_bytes = null;
  }

  if (doc.kind === "svg") {
    const problems = policy.inspectSvg(await r2.getText(doc.key, policy.KINDS.svg.maxBytes));
    if (problems.length) {
      await discard(doc);
      throw new HttpError(422, `That SVG was refused because ${problems.join(", and ")}.`, {
        code: "unsafe_svg",
      });
    }
  }

  if (doc.kind === "lottie") {
    const result = policy.inspectLottie(await r2.getText(doc.key, policy.KINDS.lottie.maxBytes));
    if (result.problems.length) {
      await discard(doc);
      throw new HttpError(
        422,
        `That Lottie file was refused because ${result.problems.join(", and ")}.`,
        { code: "bad_lottie" },
      );
    }
    patch.width = result.width;
    patch.height = result.height;
    patch.duration_ms = result.duration_ms;
  }

  return view(await db.updateMedia(id, patch));
}

async function sweepPending() {
  const stale = await db.listMedia({
    status: "pending",
    createdBefore: nowSeconds() - policy.PENDING_TTL_SECONDS,
  });
  for (const doc of stale) {
    try {
      await discard(doc);
    } catch (err) {
      console.error(`Could not sweep abandoned upload ${doc.id}:`, err.message);
    }
  }
}

async function listLibrary() {
  if (r2.isConfigured()) await sweepPending();
  const [docs, usage] = await Promise.all([db.listMedia({ status: "ready" }), db.mediaUsage()]);
  return docs.map((doc) => ({ ...view(doc), used_by: usage.get(doc.id) || [] }));
}

async function deleteMedia(id) {
  requireStorage();
  const doc = await db.getMedia(id);
  if (!doc) throw new HttpError(404, "That file does not exist.", { code: "not_found" });

  const usedBy = (await db.mediaUsage()).get(id) || [];
  if (usedBy.length) {
    const titles = usedBy.map((a) => `"${a.title || "Untitled"}"`).join(", ");
    throw new HttpError(409, `This file is still used by ${titles}.`, {
      code: "in_use",
      details: { used_by: usedBy },
    });
  }

  await Promise.all([r2.remove(doc.key), doc.poster_key ? r2.remove(doc.poster_key) : null]);
  await db.deleteMedia(id);
}

async function viewsByIds(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const docs = await db.getMediaByIds(unique);
  return new Map(docs.map((doc) => [doc.id, view(doc)]));
}

/**
 * GET /media/<key>, for private buckets.
 *
 * klndr signs the read and redirects to it. The signature is pinned to the hour
 * (see r2.presignGet), so the redirect itself can be cached for the rest of that
 * hour, and someone scrolling their inbox is not re-signing every thumbnail.
 */
async function serveObject(req, res) {
  const key = req.params[0] || "";
  if (!key.startsWith("announcements/") || !r2.isConfigured() || !r2.isSafeKey(key)) {
    return res.status(404).json({ error: "Not found" });
  }
  try {
    if (r2.mode() === "public") return res.redirect(302, r2.publicUrl(key));
    const { url, maxAge } = await r2.presignGet(key);
    res.set("Cache-Control", `private, max-age=${maxAge}`);
    res.redirect(302, url);
  } catch (err) {
    console.error("Could not sign a media read:", err);
    res.status(500).json({ error: "Could not load that file." });
  }
}

module.exports = {
  status,
  createUpload,
  completeUpload,
  listLibrary,
  deleteMedia,
  viewsByIds,
  refsIn: policy.refsIn,
  serveObject,
};
