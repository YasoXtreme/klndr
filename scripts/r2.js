#!/usr/bin/env node
/* Cloudflare R2 setup helper.
 *
 *   npm run r2:check                   Can this environment reach the bucket, and
 *                                      will a browser on klndr be allowed to upload?
 *   npm run r2:cors [-- <origin> ...]  Write the CORS policy browser uploads need.
 *
 * r2:cors always allows KLNDR_BASE_URL and http://localhost:3001. From a laptop,
 * name the production origin as well:
 *
 *   npm run r2:cors -- https://klndr.example.com
 *
 * Writing CORS needs an R2 API token with Admin Read & Write. The app itself only
 * ever needs Object Read & Write, so it is normal for this one command to need a
 * different token - or to paste the printed JSON into the dashboard instead.
 */

require("dotenv").config({ quiet: true });
const crypto = require("crypto");
const r2 = require("../server/storage/r2");

const [command, ...extraOrigins] = process.argv.slice(2);

let failures = 0;

function report(ok, label, detail) {
  const line = `  ${ok ? "✓" : "✗"} ${label}${detail ? ` - ${detail}` : ""}`;
  if (ok) {
    console.log(line);
  } else {
    failures += 1;
    console.error(line);
  }
}

function allowedOrigins() {
  const origins = new Set(["http://localhost:3001"]);
  const base = String(process.env.KLNDR_BASE_URL || "").trim().replace(/\/+$/, "");
  if (base) origins.add(base);
  for (const origin of extraOrigins) origins.add(origin.trim().replace(/\/+$/, ""));
  return [...origins];
}

function corsRules() {
  return [
    {
      allowedOrigins: allowedOrigins(),
      // GET as well as PUT: Lottie headers are fetched by script, cross-origin.
      allowedMethods: ["PUT", "GET", "HEAD"],
      allowedHeaders: ["content-type", "cache-control"],
      exposeHeaders: ["ETag"],
      maxAgeSeconds: 3600,
    },
  ];
}

async function check() {
  if (!r2.isConfigured()) {
    report(false, "Configuration", r2.problem());
    return;
  }
  report(true, "Configuration", `bucket "${process.env.R2_BUCKET.trim()}", ${r2.mode()} mode`);

  const key = `announcements/r2-check/${crypto.randomBytes(6).toString("hex")}.txt`;
  const body = `klndr r2 check ${new Date().toISOString()}`;
  const upload = await r2.presignPut(key, {
    contentType: "text/plain",
    contentLength: Buffer.byteLength(body),
    cacheControl: "no-store",
  });

  // Exactly what the Studio does: the signed URL and the headers it came with.
  const put = await fetch(upload.url, { method: "PUT", headers: upload.headers, body });
  report(put.ok, "Signed upload", put.ok ? null : `${put.status} ${(await put.text()).slice(0, 200)}`);
  if (!put.ok) return;

  try {
    const stored = await r2.head(key);
    report(
      Boolean(stored) && stored.bytes === Buffer.byteLength(body),
      "Read back",
      stored ? `${stored.bytes} bytes, ${stored.contentType}` : "the object is not there",
    );

    // If a different size gets through, the signature is not binding it, and
    // the size limits in server/media.js are only advisory.
    const tampered = await fetch(upload.url, {
      method: "PUT",
      headers: upload.headers,
      body: `${body} and then some`,
    });
    report(
      !tampered.ok,
      "Signature binds the file size",
      tampered.ok ? "a larger file was accepted" : `a larger file was refused (${tampered.status})`,
    );

    const read = await r2.presignGet(key);
    const got = await fetch(read.url);
    report(got.ok, "Signed read", got.ok ? null : `${got.status}`);

    if (r2.mode() === "public") {
      const url = r2.publicUrl(key);
      const pub = await fetch(url);
      report(
        pub.ok,
        "Public address",
        pub.ok ? url : `${pub.status} from ${url} - is public access turned on for the bucket?`,
      );
    }

    // What a browser on klndr asks R2 before every upload.
    for (const origin of allowedOrigins()) {
      const preflight = await fetch(upload.url, {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "PUT",
          "Access-Control-Request-Headers": "content-type,cache-control",
        },
      });
      const allowed = preflight.headers.get("access-control-allow-origin");
      report(
        allowed === origin || allowed === "*",
        `Browser uploads from ${origin}`,
        allowed ? null : "no CORS rule allows this origin - run npm run r2:cors",
      );
    }
  } finally {
    await r2.remove(key).catch((err) => report(false, "Clean up", err.message));
  }
}

async function cors() {
  if (!r2.isConfigured()) {
    report(false, "Configuration", r2.problem());
    return;
  }
  const rules = corsRules();
  console.log(`  Origins: ${rules[0].allowedOrigins.join(", ")}`);
  try {
    await r2.putBucketCors(rules);
    report(true, "CORS policy written");
  } catch (err) {
    report(
      false,
      "CORS policy",
      err.status === 403
        ? "this token cannot change bucket settings. Use an Admin Read & Write token for this command, or paste the JSON below into the bucket's Settings > CORS policy."
        : err.message,
    );
    const dashboardShape = rules.map((rule) => ({
      AllowedOrigins: rule.allowedOrigins,
      AllowedMethods: rule.allowedMethods,
      AllowedHeaders: rule.allowedHeaders,
      ExposeHeaders: rule.exposeHeaders,
      MaxAgeSeconds: rule.maxAgeSeconds,
    }));
    console.log(`\n${JSON.stringify(dashboardShape, null, 2)}\n`);
  }
}

async function main() {
  const commands = { check, cors };
  if (!commands[command]) {
    console.log("Usage: npm run r2:check | npm run r2:cors [-- <origin> ...]");
    process.exit(1);
  }
  console.log(`\nklndr R2 ${command}\n`);
  await commands[command]();
  console.log(failures ? `\n${failures} problem(s).\n` : "\nAll good.\n");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
