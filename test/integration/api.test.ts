import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { built } from "./built";
import { startServer, type Request, type Response, type TestServer } from "./server";

// The HTTP surface end to end, against a real server and a real (test)
// database: the guards, auth, tasks, settings, admin accounts, the
// announcement lifecycle, page caching and the media handshake. Each block
// leans on the ones before it, the way a person's session would, so the file
// runs top to bottom.

const require = createRequire(import.meta.url);
const { ensureUser } = require("../support/test-db.cjs");

const APP = built("protected");
const ADMIN_PAGE = built("admin");
const LOGIN = built("public");
// Inside its page's directory: what a path climbing out of another one has to
// reach.
const appFile = APP.js.slice("/protected/".length);
const adminFile = ADMIN_PAGE.js.slice("/admin/".length);

const run = Math.random().toString(36).slice(2, 8);
const ADMIN = `e2e_admin_${run}`;
const ADMIN_PASSWORD = `admin-pass-${run}`;

let server: TestServer;
let token = "";
let taskId = "";
let betaUser = "";
let betaToken = "";
let newcomer = "";
let newcomerToken = "";
const createdUsers: string[] = [];
const createdAnnouncements: number[] = [];

const bearer = (value: string) => ({ Authorization: `Bearer ${value}` });
const api = (method: string, path: string, as: string, body?: unknown): Promise<Response> => {
  const options: Request = { method, headers: bearer(as) };
  if (body !== undefined) options.body = body;
  return server.request(path, options);
};
const page = (path: string, as?: string) => server.request(path, as ? { headers: bearer(as) } : {});

async function signIn(username: string, password: string) {
  const res = await server.request("/api/auth/login", { method: "POST", body: { username, password } });
  return (res.json && res.json.token) as string | undefined;
}

// A new account holds a server-generated temporary password and is locked out
// of everything else until it picks its own, so do that first.
async function signInNew(username: string, tempPassword: string) {
  const signedIn = await signIn(username, tempPassword);
  if (signedIn) {
    await api("POST", "/api/auth/change-password", signedIn, {
      currentPassword: tempPassword,
      newPassword: "password2026",
      confirmPassword: "password2026",
    });
  }
  return signedIn ?? "";
}

type Post = Record<string, unknown> & { id: number; revision: number; studio_status: string };
const feedOf = (res: Response): Post[] => (res.json && res.json.announcements) || [];
const editable = (doc: Post) => ({
  title: doc.title, summary: doc.summary, body: doc.body, body_format: doc.body_format,
  kind: doc.kind, media: doc.media, cta: doc.cta, delivery: doc.delivery, audience: doc.audience,
  evergreen: doc.evergreen, pinned: doc.pinned, reactions_enabled: doc.reactions_enabled,
  publish_at: doc.publish_at, expires_at: doc.expires_at,
});
async function draft(fields: Record<string, unknown>) {
  const res = await api("POST", "/api/admin/announcements", token, fields);
  const doc: Post | undefined = res.json && res.json.announcement;
  if (doc) createdAnnouncements.push(doc.id);
  return { res, doc: doc as Post };
}

beforeAll(async () => {
  server = await startServer();
  await ensureUser(server.db, ADMIN, "admin", ADMIN_PASSWORD);
  createdUsers.push(ADMIN);
});

afterAll(async () => {
  if (!server) return;
  if (token) {
    for (const id of createdAnnouncements) await api("DELETE", `/api/admin/announcements/${id}`, token);
  }
  for (const username of createdUsers) await server.db.deleteUser(username);
  await server.stop();
});

describe("guards before signing in", () => {
  test("the app page redirects to /login", async () => {
    const res = await page("/");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/login");
  });

  test("a protected script is blocked", async () => {
    expect((await page(APP.js)).status).toBe(302);
  });

  test("an admin page redirects to /login", async () => {
    const res = await page("/admin/accounts");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/login");
  });

  // Every way of climbing out of an open directory into a guarded one. None
  // may hand over the app's code without a session.
  test.each([
    `/public/../protected/${appFile}`,
    `/public/x/../../protected/${appFile}`,
    `/public/%2e%2e/protected/${appFile}`,
    `/public/..%2fprotected/${appFile}`,
    `/public/..%5cprotected/${appFile}`,
    `/public/%252e%252e/protected/${appFile}`,
    `/public/assets/../../protected/${appFile}`,
    `/assets/../protected/${appFile}`,
    `/assets/%2e%2e/protected/${appFile}`,
  ])("%s does not leak app code", async (path) => {
    const res = await page(path);
    expect(res.status).not.toBe(200);
    expect(res.body).not.toContain(APP.sample);
  });
});

describe("auth", () => {
  test("a wrong password is a 401", async () => {
    const res = await server.request("/api/auth/login", {
      method: "POST",
      body: { username: ADMIN, password: `${ADMIN_PASSWORD}-wrong` },
    });
    expect(res.status).toBe(401);
  });

  test("a valid login returns a token and the user", async () => {
    const res = await server.request("/api/auth/login", {
      method: "POST",
      body: { username: ADMIN, password: ADMIN_PASSWORD },
    });
    expect(res.status).toBe(200);
    expect(res.json.token).toBeTruthy();
    token = res.json.token;
  });

  test("/api/auth/me returns the admin", async () => {
    const res = await api("GET", "/api/auth/me", token);
    expect(res.status).toBe(200);
    expect(res.json.user.username).toBe(ADMIN);
  });

  // cookie-parser turns a "j:" cookie into parsed JSON. With a live session in
  // the database (the one just created), a forged operator must not match it,
  // on the API or on a page.
  test("a forged JSON session cookie is not a session", async () => {
    const forged = { Cookie: `klndr_session=${encodeURIComponent('j:{"$ne":null}')}` };
    expect((await server.request("/api/auth/me", { headers: forged })).status).toBe(401);
    const forgedPage = await server.request("/", { headers: forged });
    expect(forgedPage.status).toBe(302);
    expect(forgedPage.headers.location).toBe("/login");
  });
});

describe("tasks and settings", () => {
  test("creating a task returns it", async () => {
    const res = await api("POST", "/api/tasks", token, {
      title: "Mr. Mourad Physics Session 2 Month 2",
      start_times: [1729000800],
      durations: [120],
      total_duration: 120,
      default_timing: 120,
      category: "Physics",
      color: "#9ae659",
      icon: "balance",
      is_locked: true,
    });
    expect(res.status).toBe(201);
    expect(res.json.task.title).toContain("Physics");
    taskId = res.json.task.id;
  });

  test("the task list contains it", async () => {
    const res = await api("GET", "/api/tasks", token);
    expect(res.status).toBe(200);
    expect(res.json.tasks.some((t: { id: string }) => t.id === taskId)).toBe(true);
  });

  test("an update can split it into two segments", async () => {
    const res = await api("PUT", `/api/tasks/${taskId}`, token, {
      start_times: [1729000800, 1729015200],
      durations: [240, 120],
      total_duration: 360,
    });
    expect(res.status).toBe(200);
    expect(res.json.task.start_times).toHaveLength(2);
    expect(res.json.task.total_duration).toBe(360);
  });

  test("a batch update applies", async () => {
    const res = await api("POST", "/api/tasks/batch-update", token, {
      updates: [{ id: taskId, start_times: [1729000800 + 7200], durations: [120], total_duration: 120 }],
    });
    expect(res.status).toBe(200);
    expect(res.json.updated).toHaveLength(1);
  });

  test("settings save snapToRuler and tickPercent", async () => {
    const res = await api("PUT", "/api/settings", token, { bucketHours: 2, snapToRuler: true, tickPercent: 25 });
    expect(res.status).toBe(200);
    expect(res.json.settings.snapToRuler).toBe(true);
  });

  test("a task can be deleted", async () => {
    expect((await api("DELETE", `/api/tasks/${taskId}`, token)).status).toBe(200);
  });
});

describe("admin accounts", () => {
  let tempPassword = "";

  test("an admin can create an account with a one-shot password", async () => {
    betaUser = `betatester_${run}`;
    const res = await api("POST", "/api/admin/create-user", token, { username: betaUser, role: "user" });
    expect(res.status).toBe(201);
    createdUsers.push(betaUser);
    expect(res.json.user.username).toBe(betaUser);
    expect(typeof res.json.tempPassword).toBe("string");
    expect(res.json.tempPassword.length).toBeGreaterThanOrEqual(12);
    expect(res.json.user.must_change_password).toBe(true);
    tempPassword = res.json.tempPassword;
  });

  test("the account list includes it", async () => {
    const res = await api("GET", "/api/admin/users", token);
    expect(res.status).toBe(200);
    expect(res.json.users.some((u: { username: string }) => u.username === betaUser)).toBe(true);
  });

  test("a password can be changed and changed back", async () => {
    const changed = await api("POST", "/api/auth/change-password", token, {
      currentPassword: ADMIN_PASSWORD,
      newPassword: `${ADMIN_PASSWORD}-e2e`,
      confirmPassword: `${ADMIN_PASSWORD}-e2e`,
    });
    expect(changed.status).toBe(200);
    const restored = await api("POST", "/api/auth/change-password", token, {
      currentPassword: `${ADMIN_PASSWORD}-e2e`,
      newPassword: ADMIN_PASSWORD,
      confirmPassword: ADMIN_PASSWORD,
    });
    expect(restored.status).toBe(200);
  });

  test("the new account can sign in", async () => {
    betaToken = await signInNew(betaUser, tempPassword);
    expect(betaToken).toBeTruthy();
  });
});

describe("announcements", () => {
  let story: Post;
  let live: Post;
  let evergreen: Post;

  test("an admin creates a draft that people cannot see", async () => {
    const { res, doc } = await draft({ title: "E2E story", body: "Hello **there**", kind: "feature", delivery: "story" });
    expect(res.status).toBe(200);
    expect(doc.studio_status).toBe("draft");
    story = doc;
    const feed = await api("GET", "/api/announcements/feed", betaToken);
    expect(feed.status).toBe(200);
    expect(feedOf(feed).some((a) => a.id === story.id)).toBe(false);
  });

  test("publishing an untitled post lists what is missing", async () => {
    const { doc: untitled } = await draft({ title: "" });
    const refused = await api("POST", `/api/admin/announcements/${untitled.id}/publish`, token, { revision: untitled.revision });
    expect(refused.status).toBe(422);
    expect(refused.json.problems.some((p: { field: string }) => p.field === "title")).toBe(true);
  });

  test("publishing makes it live, and unread for people already here", async () => {
    const res = await api("POST", `/api/admin/announcements/${story.id}/publish`, token, { revision: story.revision });
    expect(res.status).toBe(200);
    live = res.json.announcement;
    expect(live.studio_status).toBe("live");
    const seen = feedOf(await api("GET", "/api/announcements/feed", betaToken)).find((a) => a.id === story.id);
    expect(seen).toBeDefined();
    expect(seen?.unread).toBe(true);
    expect(seen?.delivered).toBe(false);
  });

  // The bug that started this: a brand-new account was walked through every
  // announcement ever posted. Created a second later, so it joined strictly after.
  test("a new account sees earlier posts as history, not news", async () => {
    await new Promise((resolve) => setTimeout(resolve, 1100));
    newcomer = `newcomer_${run}`;
    const res = await api("POST", "/api/admin/create-user", token, { username: newcomer, role: "user" });
    createdUsers.push(newcomer);
    newcomerToken = await signInNew(newcomer, res.json.tempPassword);
    const seen = feedOf(await api("GET", "/api/announcements/feed", newcomerToken)).find((a) => a.id === story.id);
    expect(seen).toBeDefined();
    expect(seen?.unread).toBe(false);
    expect(seen?.read).toBe(true);
  });

  test("an evergreen post does reach people who join later", async () => {
    const res = await api("PUT", `/api/admin/announcements/${story.id}`, token, { ...editable(live), evergreen: true, revision: live.revision });
    expect(res.status).toBe(200);
    evergreen = res.json.announcement;
    const seen = feedOf(await api("GET", "/api/announcements/feed", newcomerToken)).find((a) => a.id === story.id);
    expect(seen?.unread).toBe(true);
  });

  test("saving over a newer revision is refused, with the stored post", async () => {
    const stale = await api("PUT", `/api/admin/announcements/${story.id}`, token, { ...editable(live), title: "Stale edit", revision: live.revision });
    expect(stale.status).toBe(409);
    expect(stale.json.announcement.revision).toBe(evergreen.revision);
  });

  test("receipts and reactions", async () => {
    const opened = await api("POST", `/api/announcements/${story.id}/receipts`, betaToken, { event: "opened" });
    const reacted = await api("PUT", `/api/announcements/${story.id}/reaction`, betaToken, { reaction: "tada" });
    const after = feedOf(await api("GET", "/api/announcements/feed", betaToken)).find((a) => a.id === story.id);
    expect(opened.status).toBe(200);
    expect(after?.read).toBe(true);
    expect(after?.unread).toBe(false);
    expect(reacted.status).toBe(200);
    expect(reacted.json.reactions.tada).toBe(1);
    expect(after?.reaction).toBe("tada");

    const unreacted = await api("PUT", `/api/announcements/${story.id}/reaction`, betaToken, { reaction: null });
    expect(unreacted.status).toBe(200);
    expect(unreacted.json.reactions.tada).toBeFalsy();

    const badEvent = await api("POST", `/api/announcements/${story.id}/receipts`, betaToken, { event: "deleted" });
    expect(badEvent.status).toBe(400);
  });

  test("an admins-only post skips everyone else", async () => {
    const { doc } = await draft({ title: "Admins only", audience: { type: "admins" } });
    await api("POST", `/api/admin/announcements/${doc.id}/publish`, token, { revision: doc.revision });
    expect(feedOf(await api("GET", "/api/announcements/feed", betaToken)).some((a) => a.id === doc.id)).toBe(false);
    expect(feedOf(await api("GET", "/api/announcements/feed", token)).some((a) => a.id === doc.id)).toBe(true);
  });

  test("a scheduled post waits for its time", async () => {
    const { doc } = await draft({ title: "Later", publish_at: Math.floor(Date.now() / 1000) + 3600 });
    const scheduled = await api("POST", `/api/admin/announcements/${doc.id}/publish`, token, { revision: doc.revision });
    expect(scheduled.status).toBe(200);
    expect(scheduled.json.announcement.studio_status).toBe("scheduled");
    expect(feedOf(await api("GET", "/api/announcements/feed", betaToken)).some((a) => a.id === doc.id)).toBe(false);
  });

  test("the pulse answers with counts", async () => {
    const pulse = await api("GET", "/api/announcements/pulse", newcomerToken);
    expect(pulse.status).toBe(200);
    expect(typeof pulse.json.unread).toBe("number");
  });

  test("the old missed-announcements endpoint is gone", async () => {
    expect((await api("GET", "/api/announcements/missed", betaToken)).status).toBe(404);
  });

  test("the Studio API is admin-only", async () => {
    expect((await api("GET", "/api/admin/announcements", betaToken)).status).toBe(403);
  });
});

describe("the admin page", () => {
  test("a member is sent from /admin back to the app", async () => {
    const res = await page("/admin", betaToken);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/");
  });

  test("a member cannot fetch admin scripts", async () => {
    const res = await page(ADMIN_PAGE.js, betaToken);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/");
  });

  // admin/ sits beside protected/, never inside it, because a static mount
  // resolves `..` only after the guard has matched (server.js). A member is
  // past the /protected guard, so these are the paths that would reach admin
  // code if it ever moved inside.
  test.each([
    `/protected/x/../admin/${adminFile}`,
    `/protected/x/../../admin/${adminFile}`,
    `/protected/assets/../../admin/${adminFile}`,
    `/protected/%2e%2e/admin/${adminFile}`,
    `/protected/..%2fadmin/${adminFile}`,
    `/protected/..%5cadmin/${adminFile}`,
    `/protected/%252e%252e/admin/${adminFile}`,
  ])("%s does not reach admin code for a member", async (path) => {
    const res = await page(path, betaToken);
    expect(res.status).not.toBe(200);
    expect(res.body).not.toContain(ADMIN_PAGE.sample);
  });

  test("an admin deep link serves the admin page", async () => {
    const res = await page("/admin/analytics/people", token);
    expect(res.status).toBe(200);
    expect(res.body).toContain("adminContent");
  });

  test("admin scripts load for an admin", async () => {
    const res = await page(ADMIN_PAGE.js, token);
    expect(res.status).toBe(200);
    expect(res.body).toContain(ADMIN_PAGE.sample);
  });

  test("what the build leaves in .vite/ is never served", async () => {
    for (const dir of ["protected", "admin", "public"]) {
      expect((await page(`/${dir}/.vite/manifest.json`, token)).status, dir).toBe(404);
    }
  });

  test("a missing admin asset is a 404, not the page", async () => {
    expect((await page("/admin/nope.js", token)).status).toBe(404);
  });

  test("the old analytics address moves to /admin/analytics", async () => {
    const res = await page("/analytics", token);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/admin/analytics");
  });
});

// apps/server/src/pages.js: pages are always revalidated; the files the build
// named after their contents are cached for a year; the guards do not move.
describe("caching", () => {
  let appPage: Response;

  test("the app page is revalidated, privately, and reports the session cost", async () => {
    appPage = await page("/", token);
    expect(appPage.status).toBe(200);
    expect(appPage.headers["cache-control"]).toBe("private, no-cache");
    expect(appPage.headers.etag).toBeTruthy();
    expect(appPage.headers["server-timing"] ?? "").toMatch(/\bauth;dur=/);
  });

  test("an unchanged app page is a 304", async () => {
    const res = await server.request("/", { headers: { ...bearer(token), "If-None-Match": String(appPage.headers.etag) } });
    expect(res.status).toBe(304);
  });

  test("the page names the files the build hashed, and is finished", () => {
    expect(appPage.body).toContain(`src="${APP.js}"`);
    expect(appPage.body).toContain(`href="${APP.css}"`);
    expect(appPage.body).toContain('<script id="kb-js">');
    expect(appPage.body).not.toMatch(/<!--\s*klndr:/);
  });

  test("hashed files are cached a year, and the guards still hold", async () => {
    for (const url of [APP.js, APP.css]) {
      const file = await page(url, token);
      expect(file.status).toBe(200);
      expect(file.headers["cache-control"]).toBe("private, max-age=31536000, immutable");

      const signedOut = await page(url);
      expect(signedOut.status).toBe(302);
      expect(signedOut.headers.location).toBe("/login");
    }

    // Not named after its contents, so revalidated.
    const legacy = await page("/protected/vendor/lottie_light.min.js", token);
    expect(legacy.status).toBe(200);
    expect(legacy.headers["cache-control"]).toBe("private, no-cache");

    for (const url of [LOGIN.js, LOGIN.css]) {
      const file = await page(url);
      expect(file.status).toBe(200);
      expect(file.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    }
  });

  test("the font keeps its one URL, cached for a week", async () => {
    const font = await page("/assets/ElmsSans.ttf");
    expect(font.status).toBe(200);
    expect(font.headers["cache-control"]).toBe("public, max-age=604800");
    expect(appPage.body).toContain('href="/assets/ElmsSans.ttf"');
  });

  test("a member cannot fetch a hashed admin script either", async () => {
    const adminPage = await page("/admin", token);
    expect(adminPage.body).toContain(`src="${ADMIN_PAGE.js}"`);
    const res = await page(ADMIN_PAGE.js, betaToken);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/");
  });
});

describe("media", () => {
  test("storage reports whether it is set up, and round-trips an upload when it is", async () => {
    const status = await api("GET", "/api/admin/media/status", token);
    expect(status.status).toBe(200);
    expect(typeof status.json.configured).toBe("boolean");
    if (!status.json.configured) return;

    const pixel = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const signed = await api("POST", "/api/admin/media/uploads", token, {
      kind: "image", content_type: "image/png", bytes: pixel.length, filename: "e2e-pixel.png", width: 1, height: 1,
    });
    expect(signed.status).toBe(200);
    const put = await fetch(signed.json.upload.url, { method: "PUT", headers: signed.json.upload.headers, body: pixel });
    expect(put.ok).toBe(true);
    const done = await api("POST", `/api/admin/media/${signed.json.media.id}/complete`, token);
    expect(done.status).toBe(200);
    expect(done.json.media.status).toBe("ready");
    expect((await api("DELETE", `/api/admin/media/${signed.json.media.id}`, token)).status).toBe(200);
  });
});

describe("cleaning up", () => {
  test("a deleted announcement is gone", async () => {
    const id = createdAnnouncements[0]!;
    for (const each of createdAnnouncements.splice(0)) {
      expect((await api("DELETE", `/api/admin/announcements/${each}`, token)).status).toBe(200);
    }
    expect((await api("GET", `/api/admin/announcements/${id}`, token)).status).toBe(404);
  });

  test("an admin can delete an account", async () => {
    expect((await api("DELETE", `/api/admin/users/${newcomer}`, token)).status).toBe(200);
    expect((await api("DELETE", `/api/admin/users/${betaUser}`, token)).status).toBe(200);
  });

  test("logging out destroys the session", async () => {
    expect((await api("POST", "/api/auth/logout", token)).status).toBe(200);
    expect((await api("GET", "/api/auth/me", token)).status).toBe(401);
    token = "";
  });
});
