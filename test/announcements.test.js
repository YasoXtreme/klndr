// Announcement rules, the legacy read path, markdown safety and input checks.
//
// Everything here is pure: no server, no database. The API itself is exercised
// by test-e2e.js against a running instance.

const test = require("node:test");
const assert = require("node:assert/strict");

const Rules = require("../protected/js/announcements/rules");
const Markdown = require("../protected/js/announcements/markdown");
const model = require("../server/announcements/model");
const { sanitize, publishProblems } = require("../server/announcements/validate");

const DAY = 86400;
const NOW = 1_800_000_000;

function post(overrides = {}) {
  return {
    id: 40,
    status: "published",
    publish_at: NOW - 10 * DAY,
    expires_at: null,
    delivery_version: 1,
    audience: { type: "everyone", user_ids: [] },
    evergreen: false,
    ...overrides,
  };
}

function person(overrides = {}) {
  return { id: "usr_aaaaaaaaaaaa", role: "user", created_at: NOW - 100 * DAY, ...overrides };
}

function viewFor(a, user, receipt) {
  return model.userView(a, { user, receipt, now: NOW, counts: {}, mediaById: new Map() });
}

// ---------------------------------------------------------------------------
// Who gets what

test("someone who joins after thirty posts is not walked through any of them", () => {
  const newcomer = person({ created_at: NOW - DAY });
  const backlog = Array.from({ length: 30 }, (_, i) =>
    post({ id: i + 1, publish_at: NOW - (40 - i) * DAY }),
  );

  const views = backlog.map((a) => viewFor(a, newcomer, null));
  assert.equal(views.filter((v) => v.deliverable).length, 0);
  assert.equal(views.filter((v) => v.unread).length, 0);
  // Still browsable history, just not news.
  assert.ok(views.every((v) => v.read && v.delivered));
});

test("a post published after someone joined does reach them", () => {
  const member = person({ created_at: NOW - 20 * DAY });
  const view = viewFor(post({ publish_at: NOW - DAY }), member, null);
  assert.equal(view.deliverable, true);
  assert.equal(view.unread, true);
  assert.equal(view.delivered, false);
});

test("an evergreen post reaches people who join later", () => {
  const newcomer = person({ created_at: NOW - DAY });
  const welcome = post({ evergreen: true, publish_at: NOW - 300 * DAY });
  assert.equal(Rules.isDeliverable(welcome, newcomer, NOW), true);
  assert.equal(viewFor(welcome, newcomer, null).unread, true);
});

test("audiences: admins only, and specific people", () => {
  const admin = person({ id: "usr_bbbbbbbbbbbb", role: "admin" });
  const member = person();

  const adminsOnly = post({ audience: { type: "admins", user_ids: [] } });
  assert.equal(Rules.inAudience(adminsOnly, admin), true);
  assert.equal(Rules.inAudience(adminsOnly, member), false);

  const picked = post({ audience: { type: "users", user_ids: [member.id] } });
  assert.equal(Rules.inAudience(picked, member), true);
  assert.equal(Rules.inAudience(picked, admin), false);
});

test("a scheduled post goes live exactly on time, and an expired one stops", () => {
  assert.equal(Rules.isLive(post({ publish_at: NOW + 1 }), NOW), false);
  assert.equal(Rules.isLive(post({ publish_at: NOW }), NOW), true);
  assert.equal(Rules.isLive(post({ expires_at: NOW + 1 }), NOW), true);
  assert.equal(Rules.isLive(post({ expires_at: NOW }), NOW), false);
  assert.equal(Rules.isLive(post({ status: "draft" }), NOW), false);
  assert.equal(Rules.isLive(post({ status: "archived" }), NOW), false);
});

test("a skipped story is delivered, but stays unread", () => {
  const member = person();
  const receipt = { version: 1, delivered_at: NOW - 60, dismissed_at: NOW - 60 };
  const view = viewFor(post(), member, receipt);
  assert.equal(view.delivered, true);
  assert.equal(view.unread, true);
});

test("notify again makes a read post news again, including for people who joined in between", () => {
  const original = post({ publish_at: NOW - 10 * DAY });
  const resent = { ...original, delivery_version: 2, redelivered_at: NOW - DAY };
  const opened = { version: 1, delivered_at: NOW - 9 * DAY, opened_at: NOW - 9 * DAY };

  const longtime = person();
  assert.equal(Rules.isRead(original, longtime, opened), true);
  assert.equal(Rules.isRead(resent, longtime, opened), false);
  assert.equal(Rules.wasDelivered(resent, longtime, opened), false);

  const joinedBetween = person({ created_at: NOW - 5 * DAY });
  assert.equal(Rules.isDeliverable(original, joinedBetween, NOW), false);
  assert.equal(Rules.isDeliverable(resent, joinedBetween, NOW), true);
});

test("the old watermark still counts as read, but only for a first delivery", () => {
  const reader = person({ last_seen_announcement_id: 40 });
  assert.equal(Rules.isRead(post({ id: 40 }), reader, null), true);
  assert.equal(Rules.isRead(post({ id: 41 }), reader, null), false);
  assert.equal(Rules.isRead(post({ id: 12, delivery_version: 2 }), reader, null), false);
});

test("studio status", () => {
  assert.equal(Rules.studioStatus(post({ status: "draft" }), NOW), "draft");
  assert.equal(Rules.studioStatus(post({ status: "archived" }), NOW), "archived");
  assert.equal(Rules.studioStatus(post({ publish_at: NOW + DAY }), NOW), "scheduled");
  assert.equal(Rules.studioStatus(post({ expires_at: NOW - 1 }), NOW), "expired");
  assert.equal(Rules.studioStatus(post(), NOW), "live");
});

test("a draft's audience is everyone who exists now", () => {
  const users = [person({ created_at: NOW - DAY }), person({ id: "usr_cccccccccccc", created_at: NOW })];
  assert.equal(Rules.audienceOf(post({ status: "draft", publish_at: null }), users).length, 2);
  assert.equal(Rules.audienceOf(post({ publish_at: NOW - 10 * DAY }), users).length, 0);
});

// ---------------------------------------------------------------------------
// Legacy posts

test("posts from before the rewrite read as published stories for everyone", () => {
  const legacy = {
    id: 3,
    title: "Hello",
    content: "*bold* and _italic_",
    header_image_url: null,
    created_by: "usr_dddddddddddd",
    created_at: NOW - 5 * DAY,
  };
  const a = model.normalize(legacy);
  assert.equal(a.legacy, true);
  assert.equal(a.status, "published");
  assert.equal(a.publish_at, legacy.created_at);
  assert.equal(a.body, legacy.content);
  assert.equal(a.body_format, "legacy");
  assert.equal(a.delivery, "story");
  assert.deepEqual(a.audience, { type: "everyone", user_ids: [] });
  assert.equal(a.revision, 1);
});

// The renderer app.js used to ship, copied from before the rewrite. The legacy
// path has to produce exactly this.
function previousRenderer(rawText) {
  if (!rawText) return "";
  const escaped = String(rawText)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  const lines = escaped.split(/\r?\n/);
  const result = [];
  let inList = false;
  const formatInline = (str) =>
    str.replace(/\*([^*\n]+)\*/g, "<strong>$1</strong>").replace(/_([^_\n]+)_/g, "<em>$1</em>");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const listMatch = line.match(/^(\s*)\*\s+(.+)$/);
    if (listMatch) {
      if (!inList) {
        inList = true;
        result.push('<ul class="announcement-ul">');
      }
      result.push(`<li>${formatInline(listMatch[2])}</li>`);
    } else {
      if (inList) {
        inList = false;
        result.push("</ul>");
      }
      if (line.trim() === "") result.push('<div class="announcement-spacer"></div>');
      else result.push(`<p class="announcement-p">${formatInline(line)}</p>`);
    }
  }
  if (inList) result.push("</ul>");
  return result.join("");
}

test("legacy bodies render exactly as they used to", () => {
  const samples = [
    "",
    "Just a line",
    "*Bold* and _italic_ & <tags> \"quotes\" 'apostrophes'",
    "Intro\n\n* one\n* *two*\n  * three\n\nAfter the list",
    "Windows\r\nline endings\r\n* item",
  ];
  for (const sample of samples) {
    assert.equal(Markdown.render(sample, { format: "legacy" }), previousRenderer(sample));
  }
});

test("a legacy body converts to the current format without changing its meaning", () => {
  const converted = Markdown.convertLegacy("Hi *there*\n* one _two_\n* *three*");
  assert.equal(converted, "Hi **there**\n- one _two_\n- **three**");
  const html = Markdown.render(converted);
  assert.match(html, /<strong>there<\/strong>/);
  assert.match(html, /<ul class="ann-md-list"><li>one <em>two<\/em><\/li><li><strong>three<\/strong><\/li><\/ul>/);
});

// ---------------------------------------------------------------------------
// Markdown safety

test("raw HTML is shown, never run", () => {
  const html = Markdown.render('<script>alert(1)</script> <img src=x onerror=alert(1)> <a href="javascript:x">y</a>');
  assert.ok(!html.includes("<script"));
  assert.ok(!html.includes("<img src=x"));
  assert.ok(!html.includes("<a href"));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("links only allow http, https and mailto", () => {
  for (const bad of [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    " javascript:alert(1)",
    "data:text/html,<b>x</b>",
    "vbscript:msgbox",
    "//evil.example",
    "/relative/path",
  ]) {
    const html = Markdown.render(`[click](${bad})`);
    assert.ok(!/href=/.test(html), `${bad} became a link: ${html}`);
  }
  assert.match(
    Markdown.render("[docs](https://example.com/a?b=1&c=2)"),
    /<a class="ann-md-link" href="https:\/\/example\.com\/a\?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">docs<\/a>/,
  );
  assert.match(Markdown.render("[mail](mailto:hi@example.com)"), /href="mailto:hi@example.com"/);
});

test("image syntax cannot smuggle attributes or scripts", () => {
  const quoted = Markdown.render('![x" onerror="alert(1)](https://example.com/a.png)');
  assert.ok(!/onerror="/.test(quoted), quoted);
  assert.match(quoted, /alt="x&quot; onerror=&quot;alert\(1\)"/);

  assert.ok(!Markdown.render("![x](javascript:alert(1))").includes("<img"));
  assert.ok(!Markdown.render("![x](http://example.com/a.png)").includes("<img"));
  assert.match(Markdown.render("![Chart](/media/announcements/2026/09/med_0123456789abcdef/chart.png)"), /<figure/);
  assert.ok(!Markdown.render("![x](/media/../secret)").includes("<img"));
});

test("unbalanced or spaced-out emphasis stays literal", () => {
  assert.equal(Markdown.render("**not closed"), '<p class="ann-md-p">**not closed</p>');
  assert.equal(Markdown.render("2 * 3 * 4"), '<p class="ann-md-p">2 * 3 * 4</p>');
  assert.equal(Markdown.render("snake_case_name"), '<p class="ann-md-p">snake_case_name</p>');
});

test("numbers survive formatting, and forged placeholders are stripped", () => {
  assert.equal(Markdown.render("Version 2 has 3 new **things**"), '<p class="ann-md-p">Version 2 has 3 new <strong>things</strong></p>');
  assert.equal(Markdown.render("a\uE0000\uE001b"), '<p class="ann-md-p">a0b</p>');
});

test("the richer blocks render", () => {
  assert.match(Markdown.render("# Big\n## Medium"), /<h3 class="ann-md-heading">Big<\/h3><h4 class="ann-md-heading">Medium<\/h4>/);
  assert.match(Markdown.render("> [!TIP]\n> Drag to reorder"), /<aside class="ann-md-callout" data-callout="tip"><p class="ann-md-callout-title">Tip<\/p><p class="ann-md-p">Drag to reorder<\/p><\/aside>/);
  assert.match(Markdown.render("- [x] Done\n- [ ] Next"), /class="ann-md-list is-checklist".*class="ann-md-check is-done"/);
  assert.match(Markdown.render("3. three\n4. four"), /<ol class="ann-md-list" start="3">/);
  assert.match(Markdown.render("Press [[Ctrl+Z]]"), /<kbd class="ann-md-kbd">Ctrl\+Z<\/kbd>/);
  assert.match(Markdown.render("```\n<b>code</b>\n```"), /<pre class="ann-md-code"><code>&lt;b&gt;code&lt;\/b&gt;<\/code><\/pre>/);
  assert.match(Markdown.render("See https://klndr.app/docs."), /href="https:\/\/klndr\.app\/docs"/);
});

test("plain-text excerpts drop the formatting", () => {
  assert.equal(
    Markdown.toPlainText("## **Bold** [link](https://x.y) and ![pic](https://x.y/p.png)\n- [x] done"),
    "Bold link and pic done",
  );
  assert.equal(Markdown.toPlainText("*bold* _it_", { format: "legacy" }), "bold it");
  assert.equal(Markdown.toPlainText("a".repeat(300), { max: 10 }).length, 10);
});

// ---------------------------------------------------------------------------
// Input checks

test("sanitize keeps what is valid and refuses what never could be", () => {
  const fields = sanitize({
    title: "  Hello  ",
    kind: "nonsense",
    delivery: "banner",
    audience: { type: "users", user_ids: ["usr_aaaaaaaaaaaa", "usr_aaaaaaaaaaaa", "bad"] },
    media: { type: "scene", scene: { id: "stamp", props: { label: "WAY TOO LONG LABEL", color: "red" } } },
  });
  assert.equal(fields.title, "Hello");
  assert.equal(fields.kind, "feature");
  assert.equal(fields.delivery, "banner");
  assert.deepEqual(fields.audience.user_ids, ["usr_aaaaaaaaaaaa"]);
  assert.equal(fields.media.scene.clips[0].props.label, "WAY TOO LO");
  assert.equal(fields.media.scene.clips[0].props.color, "#fde047");

  assert.throws(() => sanitize({ title: "x".repeat(91) }), { status: 400 });
  assert.throws(() => sanitize({ cta: { label: "Go", url: "javascript:alert(1)" } }), { status: 400 });
  assert.throws(() => sanitize({ media: { type: "scene", scene: { id: "nope" } } }), { status: 400 });
  assert.throws(() => sanitize({ publish_at: Date.now() }), { status: 400 });
});

test("a motion header keeps its clips, loop and idle through a save", () => {
  const { media } = sanitize({
    media: {
      type: "scene",
      scene: { loop: false, clips: [{ id: "chat", props: { messages: ["Hi"] }, hold: 99 }, { id: "stamp", hold: 1.2 }] },
    },
  });
  assert.equal(media.scene.loop, false);
  assert.deepEqual(media.scene.clips.map((c) => [c.id, c.hold]), [["chat", 10], ["stamp", 1]]);
  assert.deepEqual(media.scene.clips[0].props.messages, ["Hi"]);

  assert.throws(
    () => sanitize({ media: { type: "scene", scene: { loop: true, clips: [{ id: "stamp" }, { id: "nope" }] } } }),
    { status: 400 },
  );
  assert.throws(() => sanitize({ media: { type: "scene", scene: { loop: true, clips: [] } } }), { status: 400 });
  const seven = Array.from({ length: 7 }, () => ({ id: "stamp" }));
  assert.throws(() => sanitize({ media: { type: "scene", scene: { clips: seven } } }), { status: 400 });
});

test("a motion header from before clips reads as one looping clip", () => {
  const stored = sanitize({ media: { type: "scene", scene: { id: "stamp", props: { label: "v2" } } } }).media;
  // What an older build stored: the whole scene as { id, props }.
  const legacy = { ...stored, scene: { id: "stamp", props: stored.scene.clips[0].props } };
  const read = model.normalize(post({ media: legacy })).media;
  assert.equal(read.scene.loop, true);
  assert.deepEqual(read.scene.clips.map((c) => [c.id, c.props.label, c.hold]), [["stamp", "v2", 2]]);

  // Saving it straight back is no change - so a live post is not stamped "Updated".
  assert.equal(JSON.stringify(sanitize({ media: read }).media), JSON.stringify(read));
});

test("publishing lists what is missing", () => {
  const draft = { ...sanitize({ title: "", cta: { label: "Go" }, audience: { type: "users", user_ids: [] } }) };
  const fields = publishProblems(draft, { file: null, userIds: new Set(), publishAt: NOW }).map((p) => p.field);
  assert.deepEqual(fields.sort(), ["audience", "cta", "title"]);

  const withUpload = sanitize({ title: "Ok", media: { type: "video", media_id: "med_0123456789abcdef" }, expires_at: NOW - 10 });
  const problems = publishProblems(withUpload, {
    file: { status: "ready", kind: "video" },
    userIds: new Set(),
    publishAt: NOW,
  }).map((p) => p.field);
  assert.deepEqual(problems.sort(), ["expires_at", "media.alt"]);
});
