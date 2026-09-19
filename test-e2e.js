const http = require('http');

// The port the server is actually on. .env sets PORT, so hardcoding 3000 meant
// this script could not reach a stock local instance.
require('dotenv').config({ quiet: true });
const PORT = Number(process.env.PORT) || 3000;

// The admin the suite signs in as. The defaults are the account seeded on first
// run; once that password has been changed - as it should be - set E2E_USERNAME
// and E2E_PASSWORD. Step 12 changes this password and then restores it, so
// point the suite at a disposable admin rather than a real one.
const ADMIN_USERNAME = process.env.E2E_USERNAME || 'yassen';
const ADMIN_PASSWORD = process.env.E2E_PASSWORD || 'password123';

function makeRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data,
          json
        });
      });
    });
    req.on('error', reject);
    if (postData) {
      req.write(typeof postData === 'string' ? postData : JSON.stringify(postData));
    }
    req.end();
  });
}

async function runTests() {
  console.log('\n--- STARTING KLNDR COMPREHENSIVE VERIFICATION ---\n');
  let passed = 0;
  let failed = 0;

  function assert(name, condition, details = '') {
    if (condition) {
      console.log(`✓ [PASS] ${name}`);
      passed++;
    } else {
      console.error(`✗ [FAIL] ${name} - ${details}`);
      failed++;
    }
  }

  try {
    // 1. Unauthenticated / route
    const unauthRoot = await makeRequest({
      hostname: 'localhost',
      port: PORT,
      path: '/',
      method: 'GET'
    });
    assert('Unauthenticated root redirects to /login (302)', unauthRoot.statusCode === 302 && unauthRoot.headers.location === '/login');

    // 2. Unauthenticated protected static asset
    const unauthJs = await makeRequest({
      hostname: 'localhost',
      port: PORT,
      path: '/protected/js/app.js',
      method: 'GET'
    });
    assert('Unauthenticated protected script is blocked', unauthJs.statusCode === 302);

    const unauthAdmin = await makeRequest({ hostname: 'localhost', port: PORT, path: '/admin/accounts', method: 'GET' });
    assert('Unauthenticated admin page redirects to /login', unauthAdmin.statusCode === 302 && unauthAdmin.headers.location === '/login');

    // 3. Login with invalid password
    const badLogin = await makeRequest({
      hostname: 'localhost',
      port: PORT,
      path: '/api/auth/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { username: ADMIN_USERNAME, password: `${ADMIN_PASSWORD}-wrong` });
    assert('Invalid password returns 401', badLogin.statusCode === 401);

    // 4. Valid Login
    const validLogin = await makeRequest({
      hostname: 'localhost',
      port: PORT,
      path: '/api/auth/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { username: ADMIN_USERNAME, password: ADMIN_PASSWORD });
    assert('Valid login returns 200 with token and user', validLogin.statusCode === 200 && validLogin.json && validLogin.json.token);

    const token = validLogin.json.token;
    const cookieHeader = validLogin.headers['set-cookie'] ? validLogin.headers['set-cookie'][0].split(';')[0] : '';

    // 5. Authenticated /api/auth/me
    const meRes = await makeRequest({
      hostname: 'localhost',
      port: PORT,
      path: '/api/auth/me',
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    assert('Get current user session returns the admin', meRes.statusCode === 200 && meRes.json.user.username === ADMIN_USERNAME);

    // cookie-parser turns a "j:" cookie into parsed JSON. With a live session
    // in the database (the one just created), a forged operator must not match
    // it, on the API or on a page.
    const forged = { 'Cookie': `klndr_session=${encodeURIComponent('j:{"$ne":null}')}` };
    const forgedMe = await makeRequest({ hostname: 'localhost', port: PORT, path: '/api/auth/me', method: 'GET', headers: forged });
    assert('A forged JSON session cookie is not a session (API)', forgedMe.statusCode === 401);
    const forgedPage = await makeRequest({ hostname: 'localhost', port: PORT, path: '/', method: 'GET', headers: forged });
    assert('A forged JSON session cookie is not a session (page)', forgedPage.statusCode === 302 && forgedPage.headers.location === '/login');

    // 6. Create Task
    const createdTaskRes = await makeRequest({
      hostname: 'localhost',
      port: PORT,
      path: '/api/tasks',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      }
    }, {
      title: 'Mr. Mourad Physics Session 2 Month 2',
      start_times: [1729000800],
      durations: [120],
      total_duration: 120,
      default_timing: 120,
      category: 'Physics',
      color: '#9ae659',
      icon: 'balance',
      is_locked: true
    });
    assert('Create Task returns 201 with saved task object', createdTaskRes.statusCode === 201 && createdTaskRes.json.task.title.includes('Physics'));

    const taskId = createdTaskRes.json.task.id;

    // 7. Get Tasks
    const getTasksRes = await makeRequest({
      hostname: 'localhost',
      port: PORT,
      path: '/api/tasks',
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    assert('Get Tasks returns task array containing created task', getTasksRes.statusCode === 200 && getTasksRes.json.tasks.some(t => t.id === taskId));

    // 8. Update Task (Splitting into 2 segments across a break)
    const updateTaskRes = await makeRequest({
      hostname: 'localhost',
      port: PORT,
      path: `/api/tasks/${taskId}`,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      }
    }, {
      start_times: [1729000800, 1729015200],
      durations: [240, 120],
      total_duration: 360
    });
    assert('Update Task splits segments correctly', updateTaskRes.statusCode === 200 && updateTaskRes.json.task.start_times.length === 2 && updateTaskRes.json.task.total_duration === 360);

    // 9. Batch Update (Cascading Ripple simulation)
    const batchRes = await makeRequest({
      hostname: 'localhost',
      port: PORT,
      path: '/api/tasks/batch-update',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      }
    }, {
      updates: [{
        id: taskId,
        start_times: [1729000800 + 7200],
        durations: [120],
        total_duration: 120
      }]
    });
    assert('Batch update tasks succeeds', batchRes.statusCode === 200 && batchRes.json.updated.length === 1);

    // 10. Admin create new beta user
    const testBetaUser = 'betatester_' + Math.floor(Math.random() * 10000);
    const adminCreateUser = await makeRequest({
      hostname: 'localhost',
      port: PORT,
      path: '/api/admin/create-user',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      }
    }, {
      username: testBetaUser,
      role: 'user'
    });
    assert('Admin can create beta users', adminCreateUser.statusCode === 201 && adminCreateUser.json.user.username === testBetaUser);
    assert('New user gets a generated temporary password', typeof adminCreateUser.json.tempPassword === 'string' && adminCreateUser.json.tempPassword.length >= 12);
    assert('New user must change password at first login', adminCreateUser.json.user.must_change_password === true);

    // 11. Admin list users
    const adminListUsers = await makeRequest({
      hostname: 'localhost',
      port: PORT,
      path: '/api/admin/users',
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    assert('Admin list users returns users array', adminListUsers.statusCode === 200 && adminListUsers.json.users.some(u => u.username === testBetaUser));

    // 12. Change Password
    const changePassRes = await makeRequest({
      hostname: 'localhost',
      port: PORT,
      path: '/api/auth/change-password',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      }
    }, {
      currentPassword: ADMIN_PASSWORD,
      newPassword: `${ADMIN_PASSWORD}-e2e`,
      confirmPassword: `${ADMIN_PASSWORD}-e2e`
    });
    assert('Change password succeeds', changePassRes.statusCode === 200);

    // Revert password back
    await makeRequest({
      hostname: 'localhost',
      port: PORT,
      path: '/api/auth/change-password',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      }
    }, {
      currentPassword: `${ADMIN_PASSWORD}-e2e`,
      newPassword: ADMIN_PASSWORD,
      confirmPassword: ADMIN_PASSWORD
    });

    // 13. Settings Update (0-24h bucket options)
    const settingsRes = await makeRequest({
      hostname: 'localhost',
      port: PORT,
      path: '/api/settings',
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      }
    }, {
      bucketHours: 2,
      snapToRuler: true,
      tickPercent: 25
    });
    assert('Settings update with snapToRuler and tickPercent succeeds', settingsRes.statusCode === 200 && settingsRes.json.settings.snapToRuler === true);

    // 14. Delete Task
    const delRes = await makeRequest({
      hostname: 'localhost',
      port: PORT,
      path: `/api/tasks/${taskId}`,
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    assert('Delete task succeeds', delRes.statusCode === 200);

    // 14b. Announcements: drafts, publishing, who gets what, receipts, reactions
    const api = (method, path, bearer, body) => makeRequest({
      hostname: 'localhost',
      port: PORT,
      path,
      method,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${bearer}` }
    }, body);
    const signIn = async (username, password) => {
      const res = await makeRequest({
        hostname: 'localhost',
        port: PORT,
        path: '/api/auth/login',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, { username, password });
      return res.json && res.json.token;
    };
    // A new account holds a server-generated temporary password and is locked
    // out of everything else until it picks its own, so do that first.
    const signInNew = async (username, tempPassword) => {
      const bearer = await signIn(username, tempPassword);
      if (bearer) {
        await api('POST', '/api/auth/change-password', bearer, {
          currentPassword: tempPassword, newPassword: 'password2026', confirmPassword: 'password2026'
        });
      }
      return bearer;
    };
    const feedOf = (res) => (res.json && res.json.announcements) || [];
    const editable = (doc) => ({
      title: doc.title, summary: doc.summary, body: doc.body, body_format: doc.body_format,
      kind: doc.kind, media: doc.media, cta: doc.cta, delivery: doc.delivery, audience: doc.audience,
      evergreen: doc.evergreen, pinned: doc.pinned, reactions_enabled: doc.reactions_enabled,
      publish_at: doc.publish_at, expires_at: doc.expires_at
    });
    const createdAnnouncements = [];
    const draft = async (fields) => {
      const res = await api('POST', '/api/admin/announcements', token, fields);
      const doc = res.json && res.json.announcement;
      if (doc) createdAnnouncements.push(doc.id);
      return { res, doc };
    };

    const betaToken = await signInNew(testBetaUser, adminCreateUser.json.tempPassword);
    assert('Beta user can sign in', Boolean(betaToken));

    const { res: draftRes, doc: story } = await draft({ title: 'E2E story', body: 'Hello **there**', kind: 'feature', delivery: 'story' });
    assert('Admin creates a draft announcement', draftRes.statusCode === 200 && story && story.studio_status === 'draft');

    const betaDraftFeed = await api('GET', '/api/announcements/feed', betaToken);
    assert('A draft is invisible to people', betaDraftFeed.statusCode === 200 && !feedOf(betaDraftFeed).some((a) => a.id === story.id));

    const { doc: untitled } = await draft({ title: '' });
    const refused = await api('POST', `/api/admin/announcements/${untitled.id}/publish`, token, { revision: untitled.revision });
    assert('Publishing an untitled post lists what is missing', refused.statusCode === 422 && refused.json.problems.some((p) => p.field === 'title'));

    const publishRes = await api('POST', `/api/admin/announcements/${story.id}/publish`, token, { revision: story.revision });
    const live = publishRes.json && publishRes.json.announcement;
    assert('Publishing makes it live', publishRes.statusCode === 200 && live.studio_status === 'live');

    const betaStory = feedOf(await api('GET', '/api/announcements/feed', betaToken)).find((a) => a.id === story.id);
    assert('Someone who was already here gets it as unread news', Boolean(betaStory) && betaStory.unread === true && betaStory.delivered === false);

    // The bug that started this: a brand-new account was walked through every
    // announcement ever posted. Created a second later, so it joined strictly after.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const newcomer = 'newcomer_' + Math.floor(Math.random() * 10000);
    const newcomerRes = await api('POST', '/api/admin/create-user', token, { username: newcomer, role: 'user' });
    const newcomerToken = await signInNew(newcomer, newcomerRes.json.tempPassword);
    const newcomerFeed = feedOf(await api('GET', '/api/announcements/feed', newcomerToken));
    const newcomerStory = newcomerFeed.find((a) => a.id === story.id);
    assert('A new account sees earlier posts as history, not news', Boolean(newcomerStory) && newcomerStory.unread === false && newcomerStory.read === true);

    const evergreenRes = await api('PUT', `/api/admin/announcements/${story.id}`, token, { ...editable(live), evergreen: true, revision: live.revision });
    const evergreen = evergreenRes.json && evergreenRes.json.announcement;
    const newcomerEvergreen = feedOf(await api('GET', '/api/announcements/feed', newcomerToken)).find((a) => a.id === story.id);
    assert('An evergreen post does reach people who join later', evergreenRes.statusCode === 200 && Boolean(newcomerEvergreen) && newcomerEvergreen.unread === true);

    const stale = await api('PUT', `/api/admin/announcements/${story.id}`, token, { ...editable(live), title: 'Stale edit', revision: live.revision });
    assert('Saving over a newer revision is refused, with the stored post', stale.statusCode === 409 && stale.json.announcement && stale.json.announcement.revision === evergreen.revision);

    const opened = await api('POST', `/api/announcements/${story.id}/receipts`, betaToken, { event: 'opened' });
    const reacted = await api('PUT', `/api/announcements/${story.id}/reaction`, betaToken, { reaction: 'tada' });
    const betaAfter = feedOf(await api('GET', '/api/announcements/feed', betaToken)).find((a) => a.id === story.id);
    assert('Opening a post records it as read', opened.statusCode === 200 && betaAfter.read === true && betaAfter.unread === false);
    assert('Reactions are counted', reacted.statusCode === 200 && reacted.json.reactions.tada === 1 && betaAfter.reaction === 'tada');
    const unreacted = await api('PUT', `/api/announcements/${story.id}/reaction`, betaToken, { reaction: null });
    assert('A reaction can be taken back', unreacted.statusCode === 200 && !unreacted.json.reactions.tada);
    const badEvent = await api('POST', `/api/announcements/${story.id}/receipts`, betaToken, { event: 'deleted' });
    assert('Unknown receipt events are refused', badEvent.statusCode === 400);

    const { doc: adminsOnly } = await draft({ title: 'Admins only', audience: { type: 'admins' } });
    await api('POST', `/api/admin/announcements/${adminsOnly.id}/publish`, token, { revision: adminsOnly.revision });
    const betaSeesAdminsOnly = feedOf(await api('GET', '/api/announcements/feed', betaToken)).some((a) => a.id === adminsOnly.id);
    const adminSeesAdminsOnly = feedOf(await api('GET', '/api/announcements/feed', token)).some((a) => a.id === adminsOnly.id);
    assert('An admins-only post skips everyone else', !betaSeesAdminsOnly && adminSeesAdminsOnly);

    const { doc: laterDraft } = await draft({ title: 'Later', publish_at: Math.floor(Date.now() / 1000) + 3600 });
    const scheduled = await api('POST', `/api/admin/announcements/${laterDraft.id}/publish`, token, { revision: laterDraft.revision });
    const betaSeesScheduled = feedOf(await api('GET', '/api/announcements/feed', betaToken)).some((a) => a.id === laterDraft.id);
    assert('A scheduled post waits for its time', scheduled.statusCode === 200 && scheduled.json.announcement.studio_status === 'scheduled' && !betaSeesScheduled);

    const pulse = await api('GET', '/api/announcements/pulse', newcomerToken);
    assert('The pulse answers with counts', pulse.statusCode === 200 && typeof pulse.json.unread === 'number');

    const oldMissed = await api('GET', '/api/announcements/missed', betaToken);
    assert('The old missed-announcements endpoint is gone', oldMissed.statusCode === 404);

    const studioForBeta = await api('GET', '/api/admin/announcements', betaToken);
    assert('The Studio API is admin-only', studioForBeta.statusCode === 403);

    // The admin page: one shell for every /admin URL, its assets beside it, and
    // both behind the admin guard.
    const page = (path, bearer) => makeRequest({
      hostname: 'localhost',
      port: PORT,
      path,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${bearer}` }
    });
    const adminForBeta = await page('/admin', betaToken);
    assert('A beta user is sent from /admin back to the app', adminForBeta.statusCode === 302 && adminForBeta.headers.location === '/');
    const shellForBeta = await page('/admin/shell.js', betaToken);
    assert('A beta user cannot fetch admin scripts', shellForBeta.statusCode === 302 && shellForBeta.headers.location === '/');
    const adminDeepLink = await page('/admin/analytics/people', token);
    assert('An admin deep link serves the admin page', adminDeepLink.statusCode === 200 && adminDeepLink.body.includes('adminContent'));
    const adminScript = await page('/admin/shell.js', token);
    assert('Admin scripts load for an admin', adminScript.statusCode === 200 && adminScript.body.includes('KlndrAdmin'));
    const missingAsset = await page('/admin/nope.js', token);
    assert('A missing admin asset is a 404, not the page', missingAsset.statusCode === 404);
    const oldAnalytics = await page('/analytics', token);
    assert('The old analytics address moves to /admin/analytics', oldAnalytics.statusCode === 302 && oldAnalytics.headers.location === '/admin/analytics');

    // Caching (server/pages.js). Pages are always revalidated; the files they
    // name carry a hash and are cached for a year; the guards do not move.
    const appPage = await page('/', token);
    assert('The app page is revalidated, privately', appPage.statusCode === 200 && appPage.headers['cache-control'] === 'private, no-cache' && Boolean(appPage.headers.etag));
    assert('The session lookup reports its cost', /\bauth;dur=/.test(appPage.headers['server-timing'] || ''));
    const unchanged = await makeRequest({
      hostname: 'localhost', port: PORT, path: '/', method: 'GET',
      headers: { 'Authorization': `Bearer ${token}`, 'If-None-Match': appPage.headers.etag }
    });
    assert('An unchanged app page is a 304', unchanged.statusCode === 304);

    const appJs = (appPage.body.match(/src="(\/protected\/js\/app\.js\?v=[0-9a-f]{10})"/) || [])[1];
    const themeCss = (appPage.body.match(/href="(\/public\/css\/theme\.css\?v=[0-9a-f]{10})"/) || [])[1];
    assert('The app page names its files by hash', Boolean(appJs && themeCss));
    if (appJs && themeCss) {
      const script = await page(appJs, token);
      assert('A versioned app script is cached a year, privately', script.statusCode === 200 && script.headers['cache-control'] === 'private, max-age=31536000, immutable');
      const scriptUnauth = await makeRequest({ hostname: 'localhost', port: PORT, path: appJs, method: 'GET' });
      assert('A versioned app script is still behind the login', scriptUnauth.statusCode === 302 && scriptUnauth.headers.location === '/login');
      const stale = await page('/protected/js/app.js?v=0123456789', token);
      assert('A stale hash is served but never cached', stale.statusCode === 200 && stale.headers['cache-control'] === 'private, no-cache');
      const sheet = await makeRequest({ hostname: 'localhost', port: PORT, path: themeCss, method: 'GET' });
      assert('A versioned public stylesheet is cached a year, anywhere', sheet.statusCode === 200 && /^public, max-age=31536000, immutable/.test(sheet.headers['cache-control'] || ''));
    }

    const adminPage = await page('/admin', token);
    const shellJs = (adminPage.body.match(/src="(\/admin\/shell\.js\?v=[0-9a-f]{10})"/) || [])[1];
    assert('The admin page names its files by hash', Boolean(shellJs));
    if (shellJs) {
      const shellForBetaVersioned = await page(shellJs, betaToken);
      assert('A beta user cannot fetch a versioned admin script either', shellForBetaVersioned.statusCode === 302 && shellForBetaVersioned.headers.location === '/');
    }

    const mediaStatus = await api('GET', '/api/admin/media/status', token);
    assert('Media storage reports whether it is set up', mediaStatus.statusCode === 200 && typeof mediaStatus.json.configured === 'boolean');
    if (mediaStatus.json && mediaStatus.json.configured) {
      const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
      const signed = await api('POST', '/api/admin/media/uploads', token, {
        kind: 'image', content_type: 'image/png', bytes: pixel.length, filename: 'e2e-pixel.png', width: 1, height: 1
      });
      const put = await fetch(signed.json.upload.url, { method: 'PUT', headers: signed.json.upload.headers, body: pixel });
      const done = await api('POST', `/api/admin/media/${signed.json.media.id}/complete`, token);
      assert('An upload goes straight to storage and is confirmed', signed.statusCode === 200 && put.ok && done.statusCode === 200 && done.json.media.status === 'ready');
      const removedMedia = await api('DELETE', `/api/admin/media/${signed.json.media.id}`, token);
      assert('An unused upload can be deleted', removedMedia.statusCode === 200);
    } else {
      console.log('- [SKIP] Upload round trip: R2 is not configured');
    }

    for (const id of createdAnnouncements) {
      const res = await api('DELETE', `/api/admin/announcements/${id}`, token);
      if (res.statusCode !== 200) assert(`Clean up announcement ${id}`, false, `status ${res.statusCode}`);
    }
    const gone = await api('GET', `/api/admin/announcements/${story.id}`, token);
    assert('A deleted announcement is gone', gone.statusCode === 404);
    await api('DELETE', `/api/admin/users/${newcomer}`, token);

    // 15. Admin delete user
    const delUserRes = await makeRequest({
      hostname: 'localhost',
      port: PORT,
      path: `/api/admin/users/${testBetaUser}`,
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    assert('Admin delete user succeeds', delUserRes.statusCode === 200);

    // 16. Logout
    const logoutRes = await makeRequest({
      hostname: 'localhost',
      port: PORT,
      path: '/api/auth/logout',
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    assert('Logout destroys session', logoutRes.statusCode === 200);

    // 17. Verify token no longer valid
    const postLogoutMe = await makeRequest({
      hostname: 'localhost',
      port: PORT,
      path: '/api/auth/me',
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    assert('Expired/destroyed session returns 401', postLogoutMe.statusCode === 401);

  } catch (err) {
    console.error('Test execution error:', err);
    failed++;
  }

  console.log(`\n--- TEST SUMMARY: ${passed} PASSED, ${failed} FAILED ---\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
