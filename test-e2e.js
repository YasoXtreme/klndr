const http = require('http');

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
      port: 3000,
      path: '/',
      method: 'GET'
    });
    assert('Unauthenticated root redirects to /login (302)', unauthRoot.statusCode === 302 && unauthRoot.headers.location === '/login');

    // 2. Unauthenticated protected static asset
    const unauthJs = await makeRequest({
      hostname: 'localhost',
      port: 3000,
      path: '/protected/js/app.js',
      method: 'GET'
    });
    assert('Unauthenticated protected script is blocked', unauthJs.statusCode === 302);

    // 3. Login with invalid password
    const badLogin = await makeRequest({
      hostname: 'localhost',
      port: 3000,
      path: '/api/auth/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { username: 'yassen', password: 'wrongPassword' });
    assert('Invalid password returns 401', badLogin.statusCode === 401);

    // 4. Valid Login
    const validLogin = await makeRequest({
      hostname: 'localhost',
      port: 3000,
      path: '/api/auth/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { username: 'yassen', password: 'password123' });
    assert('Valid login returns 200 with token and user', validLogin.statusCode === 200 && validLogin.json && validLogin.json.token);

    const token = validLogin.json.token;
    const cookieHeader = validLogin.headers['set-cookie'] ? validLogin.headers['set-cookie'][0].split(';')[0] : '';

    // 5. Authenticated /api/auth/me
    const meRes = await makeRequest({
      hostname: 'localhost',
      port: 3000,
      path: '/api/auth/me',
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    assert('Get current user session returns yassen', meRes.statusCode === 200 && meRes.json.user.username === 'yassen');

    // 6. Create Task
    const createdTaskRes = await makeRequest({
      hostname: 'localhost',
      port: 3000,
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
      port: 3000,
      path: '/api/tasks',
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    assert('Get Tasks returns task array containing created task', getTasksRes.statusCode === 200 && getTasksRes.json.tasks.some(t => t.id === taskId));

    // 8. Update Task (Splitting into 2 segments across a break)
    const updateTaskRes = await makeRequest({
      hostname: 'localhost',
      port: 3000,
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
      port: 3000,
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
      port: 3000,
      path: '/api/admin/create-user',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      }
    }, {
      username: testBetaUser,
      password: 'password2026',
      role: 'user'
    });
    assert('Admin can create beta users', adminCreateUser.statusCode === 201 && adminCreateUser.json.user.username === testBetaUser);

    // 11. Admin list users
    const adminListUsers = await makeRequest({
      hostname: 'localhost',
      port: 3000,
      path: '/api/admin/users',
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    assert('Admin list users returns users array', adminListUsers.statusCode === 200 && adminListUsers.json.users.some(u => u.username === testBetaUser));

    // 12. Change Password
    const changePassRes = await makeRequest({
      hostname: 'localhost',
      port: 3000,
      path: '/api/auth/change-password',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      }
    }, {
      currentPassword: 'password123',
      newPassword: 'password1234',
      confirmPassword: 'password1234'
    });
    assert('Change password succeeds', changePassRes.statusCode === 200);

    // Revert password back
    await makeRequest({
      hostname: 'localhost',
      port: 3000,
      path: '/api/auth/change-password',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      }
    }, {
      currentPassword: 'password1234',
      newPassword: 'password123',
      confirmPassword: 'password123'
    });

    // 13. Settings Update (0-24h bucket options)
    const settingsRes = await makeRequest({
      hostname: 'localhost',
      port: 3000,
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
      port: 3000,
      path: `/api/tasks/${taskId}`,
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    assert('Delete task succeeds', delRes.statusCode === 200);

    // 15. Admin delete user
    const delUserRes = await makeRequest({
      hostname: 'localhost',
      port: 3000,
      path: `/api/admin/users/${testBetaUser}`,
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    assert('Admin delete user succeeds', delUserRes.statusCode === 200);

    // 16. Logout
    const logoutRes = await makeRequest({
      hostname: 'localhost',
      port: 3000,
      path: '/api/auth/logout',
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    assert('Logout destroys session', logoutRes.statusCode === 200);

    // 17. Verify token no longer valid
    const postLogoutMe = await makeRequest({
      hostname: 'localhost',
      port: 3000,
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
