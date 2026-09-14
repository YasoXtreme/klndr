// Media library rules and R2 URL signing. No bucket and no database: the
// signing is pure WebCrypto, and the policy module does no I/O.

const test = require("node:test");
const assert = require("node:assert/strict");

const policy = require("../server/media-policy");

test("each kind has a ceiling and a list of types", () => {
  const ok = policy.checkUpload({ kind: "video", content_type: "video/mp4", bytes: 1024, filename: "Clip.MP4" });
  assert.equal(ok.ext, "mp4");

  assert.throws(() => policy.checkUpload({ kind: "video", content_type: "video/quicktime", bytes: 10 }), {
    status: 400,
    code: "bad_type",
  });
  assert.throws(
    () => policy.checkUpload({ kind: "image", content_type: "image/png", bytes: policy.KINDS.image.maxBytes + 1 }),
    { status: 413, code: "too_large" },
  );
  assert.throws(() => policy.checkUpload({ kind: "executable", content_type: "application/x-msdownload", bytes: 10 }), {
    code: "bad_kind",
  });
  assert.throws(() => policy.checkUpload({ kind: "svg", content_type: "image/svg+xml", bytes: 0 }), { code: "bad_size" });
  assert.throws(
    () => policy.checkUpload({ kind: "image", content_type: "image/png", bytes: 10, poster: { bytes: policy.POSTER.maxBytes + 1 } }),
    { code: "bad_poster" },
  );
  // Parameters on a content type are not a different type.
  assert.equal(policy.checkUpload({ kind: "lottie", content_type: "application/json; charset=utf-8", bytes: 5 }).contentType, "application/json");
});

test("keys are namespaced, slugged, and carry the media id", () => {
  const at = Date.UTC(2026, 8, 14) / 1000;
  const { key, posterKey } = policy.keysFor("med_0123456789abcdef", "Héllo Wörld (final).PNG", "png", at);
  assert.equal(key, "announcements/2026/09/med_0123456789abcdef/hello-world-final.png");
  assert.equal(posterKey, "announcements/2026/09/med_0123456789abcdef/poster.webp");
  assert.equal(policy.slugify("???.gif"), "file");

  const body = `![a](https://media.example.com/${key}) and ![b](/media/announcements/2026/10/med_fedcba9876543210/b.gif)`;
  assert.deepEqual(policy.refsIn(body), ["med_0123456789abcdef", "med_fedcba9876543210"]);
});

test("an SVG with behaviour in it is refused", () => {
  assert.deepEqual(
    policy.inspectSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#9ae659"/></svg>'),
    [],
  );
  const refused = [
    "<svg><script>alert(1)</script></svg>",
    '<svg onload="alert(1)"></svg>',
    "<svg><foreignObject><div>x</div></foreignObject></svg>",
    '<svg><a href="javascript:alert(1)"><text>x</text></a></svg>',
    '<!DOCTYPE svg [<!ENTITY x "y">]><svg></svg>',
    '<svg><image href="https://evil.example/x.png"/></svg>',
    "<svg><style>@import url(https://evil.example/x.css);</style></svg>",
    "<html><body>not an svg</body></html>",
  ];
  for (const svg of refused) assert.ok(policy.inspectSvg(svg).length > 0, svg);
});

test("a Lottie file needs the structure a player needs", () => {
  const good = JSON.stringify({ v: "5.9.0", fr: 30, ip: 0, op: 90, w: 512, h: 256, layers: [] });
  assert.deepEqual(policy.inspectLottie(good), { problems: [], width: 512, height: 256, duration_ms: 3000 });
  assert.ok(policy.inspectLottie("not json").problems.length);
  assert.ok(policy.inspectLottie("[]").problems.length);
  assert.ok(policy.inspectLottie(JSON.stringify({ fr: 30, ip: 0, op: 90, w: 1, h: 1 })).problems.length);
});

test("an upload URL binds the type, the exact size and the cache header", async () => {
  process.env.R2_ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
  process.env.R2_ACCESS_KEY_ID = "test-access-key";
  process.env.R2_SECRET_ACCESS_KEY = "test-secret-key";
  process.env.R2_BUCKET = "klndr-media";
  delete process.env.R2_PUBLIC_BASE_URL;
  const r2 = require("../server/storage/r2");

  assert.equal(r2.isConfigured(), true);
  assert.equal(r2.mode(), "private");

  const key = "announcements/2026/09/med_0123456789abcdef/clip.mp4";
  const upload = await r2.presignPut(key, {
    contentType: "video/mp4",
    contentLength: 123456,
    cacheControl: policy.CACHE_CONTROL,
  });
  const url = new URL(upload.url);
  assert.equal(url.host, "0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com");
  assert.equal(url.pathname, `/klndr-media/${key}`);
  assert.equal(url.searchParams.get("X-Amz-Expires"), "600");
  assert.equal(url.searchParams.get("X-Amz-SignedHeaders"), "cache-control;content-length;content-type;host");
  assert.match(url.searchParams.get("X-Amz-Signature"), /^[0-9a-f]{64}$/);
  assert.deepEqual(upload.headers, { "Content-Type": "video/mp4", "Cache-Control": policy.CACHE_CONTROL });

  // A different size is a different signature - which is the whole guarantee.
  const bigger = await r2.presignPut(key, {
    contentType: "video/mp4",
    contentLength: 123457,
    cacheControl: policy.CACHE_CONTROL,
  });
  assert.notEqual(new URL(bigger.url).searchParams.get("X-Amz-Signature"), url.searchParams.get("X-Amz-Signature"));

  // Reads are signed as of the hour, so the same object gets the same URL back
  // and the browser can cache it.
  const first = await r2.presignGet(key);
  const second = await r2.presignGet(key);
  assert.equal(first.url, second.url);
  assert.ok(first.maxAge >= 60 && first.maxAge <= 3600);

  assert.equal(r2.publicUrl(key), `/media/${key}`);
  assert.equal(r2.isSafeKey("announcements/../../etc/passwd"), false);
  await assert.rejects(() => r2.presignGet("../secret"));
});
