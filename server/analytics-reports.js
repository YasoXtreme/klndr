const { collections } = require("./db");
const A = require("./analytics");

const { TZ, DAY, WEEK, WEEK_EPOCH } = A;

// The five reports behind /api/admin/analytics. One per tab.
//
// Two rules run through all of them.
//
// THE O(all tasks) RULE. Never .toArray() `tasks` or `sessions` without a
// $group first. getTasks loading one person's tasks and filtering in JS is fine
// - the client needs those documents anyway - but instance-wide it is
// unbounded. Every `tasks` statistic below goes into ONE $facet so the
// collection is scanned once.
//
// THE PRIVACY RULE. No task title, no note, and no category name ever leaves a
// per-user query. Category names appear only pooled instance-wide behind a
// two-distinct-user threshold, and that threshold is enforced in the pipeline
// (see topCategories) rather than in the template, so it cannot be undone by
// someone editing the page.

const distinct = (rows) => new Set(rows.map((r) => r.user_id)).size;

function activeWindows(rows, todayTs) {
  const since = (days) => rows.filter((r) => r.day_ts > todayTs - days * DAY);
  const dau = distinct(rows.filter((r) => r.day_ts === todayTs));
  const wau = distinct(since(7));
  const mau = distinct(since(30));
  return {
    dau,
    wau,
    mau,
    // DAU:MAU - what fraction of the people who showed up this month showed up
    // today. Meaningless below a handful of accounts; the page says so.
    stickiness: mau ? Number((dau / mau).toFixed(3)) : 0,
  };
}

// ==========================================
// OVERVIEW
// ==========================================

async function overview(days) {
  const { users, tasks, settings, announcements, integrations } =
    await collections();
  const meta = await A.buildMeta(days);
  const todayTs = A.utcDayTs(meta.generated_at);

  const [
    userRows,
    taskTotals,
    settingsRows,
    announcementCount,
    integrationRows,
    signupRows,
    createdRows,
    sessions,
    activity,
  ] = await Promise.all([
    users.find({}, { projection: { _id: 0, role: 1, must_change_password: 1 } }).toArray(),
    tasks
      .aggregate([
        {
          $group: {
            _id: null,
            tasks: { $sum: 1 },
            scheduled: {
              $sum: {
                $cond: [
                  { $gt: [{ $size: { $ifNull: ["$start_times", []] } }, 0] },
                  1,
                  0,
                ],
              },
            },
            completed: { $sum: { $cond: ["$completed", 1, 0] } },
          },
        },
      ])
      .toArray(),
    settings
      .find({}, { projection: { _id: 0, "values.categories": 1 } })
      .toArray(),
    announcements.countDocuments(),
    integrations
      .find({}, { projection: { _id: 0, status: 1, last_sync_error: 1 } })
      .toArray(),
    users
      .aggregate([
        { $group: { _id: A.weekIndexExpr("$created_at"), count: { $sum: 1 } } },
      ])
      .toArray(),
    tasks
      .aggregate([
        { $match: { created_at: { $gte: meta.range.from_ts } } },
        { $group: { _id: A.weekIndexExpr("$created_at"), count: { $sum: 1 } } },
      ])
      .toArray(),
    A.sessionsByUser(),
    A.activityRows(todayTs - 30 * DAY, todayTs),
  ]);

  const totals = taskTotals[0] || { tasks: 0, scheduled: 0, completed: 0 };
  let liveSessions = 0;
  for (const row of sessions.values()) liveSessions += row.live_sessions;

  return {
    meta,
    totals: {
      users: userRows.length,
      admins: userRows.filter((u) => u.role === "admin").length,
      tasks: totals.tasks,
      scheduled_tasks: totals.scheduled,
      unscheduled_tasks: totals.tasks - totals.scheduled,
      completed_tasks: totals.completed,
      completion_rate: totals.tasks
        ? Number((totals.completed / totals.tasks).toFixed(3))
        : 0,
      avg_tasks_per_user: userRows.length
        ? Number((totals.tasks / userRows.length).toFixed(1))
        : 0,
      categories_defined: settingsRows.reduce(
        (n, s) => n + ((s.values && s.values.categories) || []).length,
        0,
      ),
      announcements: announcementCount,
      integrations_connected: integrationRows.filter(
        (i) => i.status === "connected",
      ).length,
    },
    activity: {
      ...activeWindows(activity, todayTs),
      live_sessions: liveSessions,
      accounts_with_live_session: sessions.size,
    },
    // The one complete historical series klndr owns: created_at has always been
    // written for users. Note it is the PROVISIONING date - there is no
    // self-signup - so the label on this chart matters.
    signups: A.fillWeeks(signupRows, meta.range.from_ts, meta.range.to_ts),
    tasks_created: A.fillWeeks(createdRows, meta.range.from_ts, meta.range.to_ts),
    health: {
      must_change_password: userRows.filter((u) => u.must_change_password).length,
      integrations_reauth_required: integrationRows.filter(
        (i) => i.status === "reauth_required",
      ).length,
      integrations_with_error: integrationRows.filter((i) => i.last_sync_error)
        .length,
    },
  };
}

// ==========================================
// PEOPLE
// ==========================================

function activeBadge(lastSeen, todayTs, createdAt, watchingSince) {
  // "Never came back" and "we were not watching yet" are different states and
  // must not collapse into one another.
  //
  // An absent last_seen_at only means dormant if we were watching for this
  // account's whole life. If the account predates instrumentation we have no
  // evidence either way, and saying dormant would be a claim about someone who
  // may well be using klndr daily.
  if (!lastSeen) {
    const watchedFromBirth =
      watchingSince != null && createdAt != null && createdAt >= watchingSince;
    return watchedFromBirth ? "dormant" : "unknown";
  }
  const age = todayTs - A.utcDayTs(lastSeen);
  if (age <= 0) return "today";
  if (age <= 7 * DAY) return "this_week";
  if (age <= 30 * DAY) return "this_month";
  return "dormant";
}

async function people(days) {
  const { users, settings, integrations, announcements } = await collections();
  const meta = await A.buildMeta(days);
  const todayTs = A.utcDayTs(meta.generated_at);
  const watchingSince = meta.instrumented_since.activity;

  const [userRows, taskStats, sessions, settingsRows, integrationRows, allActivity, recentActivity, lastAnnouncement] =
    await Promise.all([
      users.find({}, { projection: { _id: 0, password_hash: 0 } }).toArray(),
      A.taskStatsByUser(),
      A.sessionsByUser(),
      settings.find({}, { projection: { _id: 0 } }).toArray(),
      integrations
        .find(
          {},
          {
            projection: {
              _id: 0,
              user_id: 1,
              provider: 1,
              status: 1,
              last_synced_at: 1,
              last_sync_error: 1,
            },
          },
        )
        .toArray(),
      A.activityRows(null, null),
      A.activityRows(todayTs - 30 * DAY, todayTs, true),
      announcements.find({}).sort({ id: -1 }).limit(1).next(),
    ]);

  const streaks = A.streaksByUser(allActivity, todayTs);
  const settingsByUser = new Map(settingsRows.map((s) => [s.user_id, s]));
  const recentByUser = new Map();
  for (const row of recentActivity) {
    const cur = recentByUser.get(row.user_id) || { days: 0, pings: 0 };
    cur.days += 1;
    cur.pings += row.pings || 0;
    recentByUser.set(row.user_id, cur);
  }
  const integrationsByUser = new Map();
  for (const row of integrationRows) {
    if (!integrationsByUser.has(row.user_id)) integrationsByUser.set(row.user_id, []);
    integrationsByUser.get(row.user_id).push({
      provider: row.provider,
      status: row.status,
      last_synced_at: row.last_synced_at || null,
      has_error: Boolean(row.last_sync_error),
    });
  }
  const latestAnnouncementId = lastAnnouncement ? lastAnnouncement.id : 0;

  const rows = userRows.map((user) => {
    const session = sessions.get(user.id);
    const tasks = taskStats.get(user.id) || {
      total: 0,
      scheduled: 0,
      completed: 0,
      imported: 0,
      uncategorised: 0,
      planned_minutes: 0,
    };
    const streak = streaks.get(user.id);
    const recent = recentByUser.get(user.id) || { days: 0, pings: 0 };
    const userSettings = settingsByUser.get(user.id);
    const categories =
      userSettings && userSettings.values && userSettings.values.categories;

    // Derived, not stored. sessions.created_at is a real login instant, just a
    // lossy one - rows vanish on logout, password change and admin reset - so
    // it fills the gap before instrumentation without being written into the
    // field that means "we observed this". The tag says which you are reading.
    const lastLogin = user.last_login_at || (session ? session.newest_login : null);

    return {
      id: user.id,
      username: user.username,
      role: user.role,
      created_at: user.created_at,
      last_login_at: lastLogin,
      last_login_source: user.last_login_at
        ? "login"
        : session
          ? "session"
          : null,
      // Not derivable from anything: surviving-session count is "devices
      // currently signed in", a different question. Renders as an em dash.
      login_count: user.login_count != null ? user.login_count : null,
      last_seen_at: user.last_seen_at || null,
      active_badge: activeBadge(
        user.last_seen_at,
        todayTs,
        user.created_at,
        watchingSince,
      ),
      must_change_password: Boolean(user.must_change_password),
      live_sessions: session ? session.live_sessions : 0,
      tasks: {
        total: tasks.total,
        scheduled: tasks.scheduled,
        unscheduled: tasks.total - tasks.scheduled,
        completed: tasks.completed,
        imported: tasks.imported,
        uncategorised: tasks.uncategorised,
        planned_minutes: tasks.planned_minutes,
        completion_rate: tasks.total
          ? Number((tasks.completed / tasks.total).toFixed(3))
          : 0,
      },
      // Count only. The names are this person's own words and never appear on
      // an individual row - see the privacy rule at the top of this file.
      categories: {
        state: Array.isArray(categories) ? "migrated" : "unmigrated",
        count: Array.isArray(categories) ? categories.length : 0,
      },
      settings: userSettings
        ? { state: "custom", ...userSettings.values, categories: undefined }
        : { state: "default" },
      integrations: integrationsByUser.get(user.id) || [],
      activity: {
        days_active_30: recent.days,
        pings_30: recent.pings,
        // pings x window. A proxy, labelled as one: there is no logout beacon,
        // so real session length is not observable.
        active_minutes_30: recent.pings * 5,
        current_streak: streak ? streak.current_streak : 0,
        longest_streak: streak ? streak.longest_streak : 0,
        first_active_at: streak ? streak.first_active_at : null,
      },
      announcements: {
        last_seen_id: user.last_seen_announcement_id || 0,
        unread: Math.max(
          0,
          latestAnnouncementId - (user.last_seen_announcement_id || 0),
        ),
      },
    };
  });

  return { meta, users: rows };
}

// ==========================================
// ENGAGEMENT
// ==========================================

async function engagement(days) {
  const { users, activity } = await collections();
  const meta = await A.buildMeta(days);
  const todayTs = A.utcDayTs(meta.generated_at);
  const fromTs = A.utcDayTs(meta.range.from_ts);

  const [allActivity, userRows, heatmapRows, firstAt] = await Promise.all([
    A.activityRows(null, null, true),
    users.find({}, { projection: { _id: 0, id: 1, username: 1, created_at: 1 } }).toArray(),
    activity
      .aggregate([
        { $match: { day_ts: { $gte: fromTs } } },
        {
          $project: {
            user_id: 1,
            day_ts: 1,
            hours: { $objectToArray: { $ifNull: ["$hours", {}] } },
          },
        },
        { $unwind: "$hours" },
        {
          $project: {
            user_id: 1,
            pings: "$hours.v",
            at: A.asDate({
              $add: [
                "$day_ts",
                { $multiply: [{ $toInt: "$hours.k" }, 3600] },
              ],
            }),
          },
        },
        {
          $group: {
            _id: {
              dow: { $dayOfWeek: { date: "$at", timezone: TZ } },
              hour: { $hour: { date: "$at", timezone: TZ } },
            },
            pings: { $sum: "$pings" },
            users: { $addToSet: "$user_id" },
          },
        },
        {
          $project: {
            _id: 0,
            dow: "$_id.dow",
            hour: "$_id.hour",
            pings: 1,
            users: { $size: "$users" },
          },
        },
      ])
      .toArray(),
    A.firstActivityByUser(),
  ]);

  // --- daily series ---
  const byDay = new Map();
  for (const row of allActivity) {
    if (!byDay.has(row.day_ts)) byDay.set(row.day_ts, new Set());
    byDay.get(row.day_ts).add(row.user_id);
  }
  const rolling = (day, span) => {
    const seen = new Set();
    for (let d = day - (span - 1) * DAY; d <= day; d += DAY) {
      const set = byDay.get(d);
      if (set) for (const u of set) seen.add(u);
    }
    return seen.size;
  };
  const series = [];
  for (let day = fromTs; day <= todayTs; day += DAY) {
    const dau = (byDay.get(day) || new Set()).size;
    const mau = rolling(day, 30);
    series.push({
      day: new Date(day * 1000).toISOString().slice(0, 10),
      day_ts: day,
      dau,
      wau: rolling(day, 7),
      mau,
      stickiness: mau ? Number((dau / mau).toFixed(3)) : 0,
    });
  }

  // --- first-ever active day, for new vs returning and activation ---
  const firstSeen = new Map();
  for (const row of allActivity) {
    const prior = firstSeen.get(row.user_id);
    if (prior == null || row.day_ts < prior) firstSeen.set(row.user_id, row.day_ts);
  }

  const weekOf = (ts) => Math.floor((ts - WEEK_EPOCH) / WEEK);
  const newReturning = new Map();
  for (const [day, usersOnDay] of byDay) {
    if (day < fromTs) continue;
    const w = weekOf(day);
    if (!newReturning.has(w)) newReturning.set(w, { fresh: new Set(), back: new Set() });
    const bucket = newReturning.get(w);
    for (const u of usersOnDay) {
      if (weekOf(firstSeen.get(u)) === w) bucket.fresh.add(u);
      else bucket.back.add(u);
    }
  }
  const new_vs_returning = [...newReturningWeeks(newReturning)];

  // --- retention, provisioned-week cohorts ---
  const daysByUser = new Map();
  for (const row of allActivity) {
    if (!daysByUser.has(row.user_id)) daysByUser.set(row.user_id, []);
    daysByUser.get(row.user_id).push(row.day_ts);
  }
  const instrumented = meta.instrumented_since.activity;
  const cohorts = new Map();
  for (const user of userRows) {
    // A cohort straddling the start of instrumentation reads as total churn,
    // which is worse than a missing row: it is a chart that is confidently
    // wrong. Only cohorts formed after we started watching are shown.
    if (instrumented == null || user.created_at < instrumented) continue;
    const w = weekOf(user.created_at);
    if (!cohorts.has(w)) cohorts.set(w, { size: 0, activated: 0, cells: new Map() });
    const cohort = cohorts.get(w);
    cohort.size += 1;
    const days = daysByUser.get(user.id) || [];
    if (days.length) cohort.activated += 1;
    const cohortStart = w * WEEK + WEEK_EPOCH;
    for (const offset of new Set(
      days.map((dayTs) => Math.floor((dayTs - cohortStart) / WEEK)),
    )) {
      if (offset < 0) continue;
      if (!cohort.cells.has(offset)) cohort.cells.set(offset, new Set());
      cohort.cells.get(offset).add(user.id);
    }
  }

  // --- activation lag ---
  // Measured from the first instant seen, not the first day. Clamped at zero
  // rather than discarded: an account provisioned and opened within the same
  // minute is a real, and rather good, activation - not a data error.
  const lags = userRows
    .map((u) => {
      const first = firstAt.get(u.id);
      return first == null ? null : Math.max(0, (first - u.created_at) / 3600);
    })
    .filter((v) => v != null)
    .sort((a, b) => a - b);

  const streaks = A.streaksByUser(allActivity, todayTs);
  const streakDistribution = new Map();
  for (const s of streaks.values()) {
    streakDistribution.set(
      s.longest_streak,
      (streakDistribution.get(s.longest_streak) || 0) + 1,
    );
  }
  const usernames = new Map(userRows.map((u) => [u.id, u.username]));

  const totalPings = allActivity
    .filter((r) => r.day_ts >= fromTs)
    .reduce((n, r) => n + (r.pings || 0), 0);
  const activeDayCount = allActivity.filter((r) => r.day_ts >= fromTs).length;

  return {
    meta,
    series,
    new_vs_returning,
    retention: {
      cohort_unit: "week",
      // Not "signed up". klndr has no self-signup; this is when an admin
      // created the account.
      basis: "provisioned",
      cohorts: [...cohorts.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([w, c]) => ({
          cohort: A.weekLabel(w),
          cohort_ts: w * WEEK + WEEK_EPOCH,
          size: c.size,
          activated: c.activated,
          cells: [...c.cells.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([week, set]) => ({ week, users: set.size })),
        })),
    },
    activation: {
      median_hours_to_first_seen: lags.length
        ? Number(lags[Math.floor(lags.length / 2)].toFixed(1))
        : null,
      never_activated: userRows.filter((u) => !firstSeen.has(u.id)).length,
      measured: lags.length,
    },
    heatmap: { tz: TZ, cells: heatmapRows },
    streaks: {
      distribution: [...streakDistribution.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([streak, count]) => ({ streak, users: count })),
      top: [...streaks.entries()]
        .map(([id, s]) => ({
          username: usernames.get(id) || id,
          current: s.current_streak,
          longest: s.longest_streak,
        }))
        .sort((a, b) => b.longest - a.longest || b.current - a.current)
        .slice(0, 10),
    },
    time_proxy: {
      median_active_minutes_per_day: activeDayCount
        ? Number(((totalPings * 5) / activeDayCount).toFixed(1))
        : 0,
      // Stated rather than implied: there is no logout beacon, so this is a
      // count of five-minute windows in which somebody was present, not
      // measured time on the app.
      basis: "pings x 5min window",
    },
  };
}

function* newReturningWeeks(map) {
  for (const [w, bucket] of [...map.entries()].sort((a, b) => a[0] - b[0])) {
    yield {
      week: A.weekLabel(w),
      week_ts: w * WEEK + WEEK_EPOCH,
      new: bucket.fresh.size,
      returning: bucket.back.size,
    };
  }
}

// ==========================================
// PLANNING & TASKS
// ==========================================

async function taskReport(days) {
  const { tasks, settings, users } = await collections();
  const meta = await A.buildMeta(days);

  const [facets, settingsRows, userCount] = await Promise.all([
    tasks
      .aggregate(
        [
          {
            $facet: {
              totals: [
                {
                  $group: {
                    _id: null,
                    tasks: { $sum: 1 },
                    scheduled: {
                      $sum: {
                        $cond: [
                          { $gt: [{ $size: { $ifNull: ["$start_times", []] } }, 0] },
                          1,
                          0,
                        ],
                      },
                    },
                    completed: { $sum: { $cond: ["$completed", 1, 0] } },
                    // $ne: false, not $eq: true. is_locked defaults to true and
                    // a record written before the field existed simply lacks it.
                    locked: { $sum: { $cond: [{ $ne: ["$is_locked", false] }, 1, 0] } },
                    imported: {
                      $sum: { $cond: [{ $ifNull: ["$source_app", false] }, 1, 0] },
                    },
                    uncategorised: {
                      $sum: {
                        $cond: [
                          { $in: [{ $ifNull: ["$category", null] }, [null, ""]] },
                          1,
                          0,
                        ],
                      },
                    },
                    planned_minutes: { $sum: { $ifNull: ["$total_duration", 0] } },
                  },
                },
              ],
              duration_histogram: [
                {
                  $bucket: {
                    groupBy: { $ifNull: ["$total_duration", 0] },
                    boundaries: [0, 15, 30, 45, 60, 90, 120, 180, 240, 480, 1441],
                    default: "over",
                    output: { tasks: { $sum: 1 } },
                  },
                },
              ],
              segments_per_task: [
                {
                  $project: {
                    n: {
                      $let: {
                        vars: {
                          segs: { $size: { $ifNull: ["$segments", []] } },
                          starts: { $size: { $ifNull: ["$start_times", []] } },
                        },
                        // Records written before segments existed carry only the
                        // parallel arrays. Reading `segments` alone would file
                        // every one of them under zero blocks and invent a spike.
                        in: {
                          $cond: [{ $gt: ["$$segs", 0] }, "$$segs", "$$starts"],
                        },
                      },
                    },
                  },
                },
                { $group: { _id: "$n", tasks: { $sum: 1 } } },
                { $sort: { _id: 1 } },
              ],
              created_over_time: [
                { $match: { created_at: { $gte: meta.range.from_ts } } },
                { $group: { _id: A.weekIndexExpr("$created_at"), count: { $sum: 1 } } },
              ],
              completed_over_time: [
                { $match: { completed_at: { $gte: meta.range.from_ts } } },
                { $group: { _id: A.weekIndexExpr("$completed_at"), count: { $sum: 1 } } },
              ],
              // Weighted by segment duration, which is the number that matches
              // what this app is for: a three-block task finished across a week
              // is not one Friday event.
              completed_minutes: [
                { $unwind: { path: "$segments", preserveNullAndEmptyArrays: false } },
                { $match: { "segments.completed_at": { $gte: meta.range.from_ts } } },
                {
                  $group: {
                    _id: A.weekIndexExpr("$segments.completed_at"),
                    count: { $sum: { $ifNull: ["$segments.duration", 0] } },
                  },
                },
              ],
              completion_latency: [
                {
                  $match: {
                    created_at: { $exists: true },
                    completed_at: { $exists: true },
                  },
                },
                {
                  $project: {
                    hours: {
                      $divide: [{ $subtract: ["$completed_at", "$created_at"] }, 3600],
                    },
                  },
                },
                { $match: { hours: { $gte: 0 } } },
                {
                  $bucket: {
                    groupBy: "$hours",
                    boundaries: [0, 1, 6, 24, 72, 168, 720, 100000],
                    default: "over",
                    // Deliberately no $push of the values themselves: that
                    // materialises one array entry per completed task inside the
                    // stage. The median is taken separately, exactly, by
                    // skipping to the middle of a sort.
                    output: { tasks: { $sum: 1 } },
                  },
                },
              ],
              planned: [
                { $match: { "start_times.0": { $exists: true } } },
                { $unwind: { path: "$start_times", includeArrayIndex: "i" } },
                {
                  $project: {
                    start: "$start_times",
                    // Paired by the unwound index. Any other pairing silently
                    // gives every block the length of the first one.
                    minutes: { $ifNull: [{ $arrayElemAt: ["$durations", "$i"] }, 60] },
                  },
                },
                // Guards the $range below: a corrupt duration would otherwise
                // generate an unbounded array and blow the stage memory limit.
                { $match: { minutes: { $gt: 0, $lte: 1440 }, start: { $gt: 0 } } },
                {
                  $project: {
                    slices: {
                      $let: {
                        vars: {
                          h0: { $toInt: { $floor: { $divide: ["$start", 3600] } } },
                          h1: {
                            $toInt: {
                              $floor: {
                                $divide: [
                                  {
                                    $subtract: [
                                      { $add: ["$start", { $multiply: ["$minutes", 60] }] },
                                      1,
                                    ],
                                  },
                                  3600,
                                ],
                              },
                            },
                          },
                          endTs: { $add: ["$start", { $multiply: ["$minutes", 60] }] },
                        },
                        // One entry per clock hour the block touches, weighted
                        // by the minutes it actually occupies there. Attributing
                        // a four-hour block entirely to its start hour leaves
                        // the afternoon empty on a chart whose whole point is
                        // when the work sits.
                        in: {
                          $map: {
                            input: { $range: ["$$h0", { $add: ["$$h1", 1] }] },
                            as: "h",
                            in: {
                              hour_ts: { $multiply: ["$$h", 3600] },
                              minutes: {
                                $divide: [
                                  {
                                    $subtract: [
                                      {
                                        $min: [
                                          "$$endTs",
                                          { $multiply: [{ $add: ["$$h", 1] }, 3600] },
                                        ],
                                      },
                                      { $max: ["$start", { $multiply: ["$$h", 3600] }] },
                                    ],
                                  },
                                  60,
                                ],
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
                { $unwind: "$slices" },
                {
                  $project: {
                    minutes: "$slices.minutes",
                    at: A.asDate("$slices.hour_ts"),
                  },
                },
                {
                  $group: {
                    _id: {
                      dow: { $dayOfWeek: { date: "$at", timezone: TZ } },
                      hour: { $hour: { date: "$at", timezone: TZ } },
                    },
                    minutes: { $sum: "$minutes" },
                  },
                },
              ],
              top_categories: [
                { $match: { category: { $nin: [null, ""] } } },
                // Lowercased to pool, matching how the rest of the app compares
                // category names: "Physics" and "physics" are one category.
                {
                  $group: {
                    _id: { $toLower: "$category" },
                    display: { $first: "$category" },
                    tasks: { $sum: 1 },
                    users: { $addToSet: "$user_id" },
                  },
                },
                // THE THRESHOLD. A name only one person uses is that person's
                // private label: it is counted here and then dropped. Enforced
                // in the pipeline so no template edit can leak it.
                { $match: { $expr: { $gte: [{ $size: "$users" }, 2] } } },
                {
                  $project: {
                    _id: 0,
                    name: "$display",
                    tasks: 1,
                    // Size, never the array itself. This projection is
                    // load-bearing.
                    users: { $size: "$users" },
                  },
                },
                { $sort: { tasks: -1 } },
                { $limit: 25 },
              ],
            },
          },
        ],
        { allowDiskUse: true },
      )
      .next(),
    settings.find({}, { projection: { _id: 0, "values.categories": 1 } }).toArray(),
    users.countDocuments(),
  ]);

  const totals = facets.totals[0] || {
    tasks: 0,
    scheduled: 0,
    completed: 0,
    locked: 0,
    imported: 0,
    uncategorised: 0,
    planned_minutes: 0,
  };

  const latencySample = facets.completion_latency.reduce(
    (n, b) => n + b.tasks,
    0,
  );
  const latencyMedian = latencySample
    ? await medianLatencyHours(tasks, latencySample)
    : null;

  const perUser = new Map();
  let unmigrated = 0;
  for (const row of settingsRows) {
    const list = row.values && row.values.categories;
    if (!Array.isArray(list)) {
      unmigrated += 1;
      continue;
    }
    perUser.set(list.length, (perUser.get(list.length) || 0) + 1);
  }
  // Anyone with no settings document at all has never defined a category.
  const withoutSettings = userCount - settingsRows.length;
  if (withoutSettings > 0) perUser.set(0, (perUser.get(0) || 0) + withoutSettings);

  return {
    meta,
    totals: {
      ...totals,
      unscheduled: totals.tasks - totals.scheduled,
      open: totals.tasks - totals.completed,
      unlocked: totals.tasks - totals.locked,
      local: totals.tasks - totals.imported,
      completion_rate: totals.tasks
        ? Number((totals.completed / totals.tasks).toFixed(3))
        : 0,
    },
    duration_histogram: facets.duration_histogram.map((b) => ({
      from: b._id === "over" ? 1441 : b._id,
      tasks: b.tasks,
    })),
    segments_per_task: facets.segments_per_task.map((b) => ({
      segments: b._id,
      tasks: b.tasks,
    })),
    created_over_time: A.fillWeeks(
      facets.created_over_time,
      meta.range.from_ts,
      meta.range.to_ts,
    ),
    completed_over_time: A.fillWeeks(
      facets.completed_over_time,
      meta.range.from_ts,
      meta.range.to_ts,
    ),
    completed_minutes: A.fillWeeks(
      facets.completed_minutes,
      meta.range.from_ts,
      meta.range.to_ts,
    ),
    completion_latency: {
      sample: latencySample,
      median_hours: latencyMedian,
      buckets: facets.completion_latency.map((b) => ({
        from_hours: b._id === "over" ? 100000 : b._id,
        tasks: b.tasks,
      })),
    },
    planned_by_weekday: collapse(facets.planned, "dow"),
    planned_by_hour: collapse(facets.planned, "hour"),
    planned_grid: facets.planned.map((p) => ({
      dow: p._id.dow,
      hour: p._id.hour,
      minutes: Math.round(p.minutes),
    })),
    top_categories: facets.top_categories,
    categories_per_user: {
      unmigrated,
      distribution: [...perUser.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([categories, users]) => ({ categories, users })),
    },
  };
}

// Exact median without holding every value: sort and skip to the middle. Both
// ends of this measurement are instrumented, so the sample is only ever tasks
// created after the feature shipped.
async function medianLatencyHours(tasks, sample) {
  const row = await tasks
    .aggregate([
      { $match: { created_at: { $exists: true }, completed_at: { $exists: true } } },
      {
        $project: {
          hours: { $divide: [{ $subtract: ["$completed_at", "$created_at"] }, 3600] },
        },
      },
      { $match: { hours: { $gte: 0 } } },
      { $sort: { hours: 1 } },
      { $skip: Math.floor(sample / 2) },
      { $limit: 1 },
    ])
    .next();
  return row ? Number(row.hours.toFixed(1)) : null;
}

function collapse(rows, key) {
  const out = new Map();
  for (const row of rows) {
    const k = row._id[key];
    out.set(k, (out.get(k) || 0) + row.minutes);
  }
  return [...out.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([value, minutes]) => ({ [key]: value, minutes: Math.round(minutes) }));
}

// ==========================================
// SYSTEM & HEALTH
// ==========================================

async function system(days) {
  const { users, sessions, integrations, announcements, settings, tasks, activity } =
    await collections();
  const meta = await A.buildMeta(days);

  const [
    userRows,
    sessionRows,
    integrationRows,
    announcementRows,
    settingsRows,
    taskSourceRows,
    activityCount,
    activityDays,
  ] = await Promise.all([
    users
      .find(
        {},
        {
          projection: {
            _id: 0,
            id: 1,
            role: 1,
            must_change_password: 1,
            last_login_at: 1,
            last_seen_announcement_id: 1,
          },
        },
      )
      .toArray(),
    sessions
      .aggregate([
        { $match: { expires_at: { $gt: new Date() } } },
        { $group: { _id: "$user_id", n: { $sum: 1 } } },
      ])
      .toArray(),
    integrations.find({}, { projection: { _id: 0, access_token: 0, refresh_token: 0 } }).toArray(),
    announcements.find({}).sort({ id: 1 }).toArray(),
    settings.find({}, { projection: { _id: 0 } }).toArray(),
    tasks
      .aggregate([
        {
          $group: {
            _id: { $ifNull: ["$source_app", null] },
            tasks: { $sum: 1 },
          },
        },
      ])
      .toArray(),
    activity.countDocuments(),
    activity.aggregate([{ $group: { _id: "$day_ts" } }, { $count: "n" }]).next(),
  ]);

  const sessionHistogram = new Map();
  let liveSessions = 0;
  for (const row of sessionRows) {
    liveSessions += row.n;
    sessionHistogram.set(row.n, (sessionHistogram.get(row.n) || 0) + 1);
  }

  const byProvider = new Map();
  for (const row of integrationRows) {
    if (!byProvider.has(row.provider)) {
      byProvider.set(row.provider, {
        provider: row.provider,
        connected: 0,
        reauth_required: 0,
        with_error: 0,
        never_synced: 0,
        dismissed_items: 0,
        sync_ages: [],
      });
    }
    const p = byProvider.get(row.provider);
    if (row.status === "connected") p.connected += 1;
    if (row.status === "reauth_required") p.reauth_required += 1;
    if (row.last_sync_error) p.with_error += 1;
    if (!row.last_synced_at) p.never_synced += 1;
    else p.sync_ages.push((meta.generated_at - row.last_synced_at) / 3600);
    p.dismissed_items += (row.dismissed_ids || []).length;
  }

  // Watermark semantics: last_seen_announcement_id marks everything up to and
  // including that id as seen, so this is a CUMULATIVE read-through rate -
  // "read at least this far" - not a per-announcement open rate. One pass over
  // the users already in memory, not N countDocuments calls.
  const eligible = userRows.length;
  const announcementStats = announcementRows.map((a) => {
    const readThrough = userRows.filter(
      (u) => (u.last_seen_announcement_id || 0) >= a.id,
    ).length;
    return {
      id: a.id,
      title: a.title,
      created_at: a.created_at,
      read_through: readThrough,
      eligible,
      rate: eligible ? Number((readThrough / eligible).toFixed(3)) : 0,
    };
  });

  const distribution = (key) => {
    const out = new Map();
    for (const row of settingsRows) {
      const value = row.values ? row.values[key] : undefined;
      if (value === undefined) continue;
      out.set(String(value), (out.get(String(value)) || 0) + 1);
    }
    return [...out.entries()].map(([value, users]) => ({ value, users }));
  };

  return {
    meta,
    sessions: {
      live: liveSessions,
      accounts_with_live_session: sessionRows.length,
      per_user_histogram: [...sessionHistogram.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([n, users]) => ({ sessions: n, users })),
      // Rendered on the page, not just carried here. A klndr session lasts 30
      // days, so a browser closed three weeks ago still counts - this is not
      // "people online", and the number is misleading without the sentence.
      note: "A session lasts 30 days. This counts accounts holding a valid session, not people online.",
    },
    integrations: {
      by_provider: [...byProvider.values()].map((p) => {
        const ages = p.sync_ages.sort((a, b) => a - b);
        return {
          provider: p.provider,
          connected: p.connected,
          reauth_required: p.reauth_required,
          with_error: p.with_error,
          never_synced: p.never_synced,
          dismissed_items: p.dismissed_items,
          median_hours_since_sync: ages.length
            ? Number(ages[Math.floor(ages.length / 2)].toFixed(1))
            : null,
        };
      }),
    },
    announcements: announcementStats,
    accounts: {
      must_change_password: userRows.filter((u) => u.must_change_password).length,
      roles: {
        admin: userRows.filter((u) => u.role === "admin").length,
        user: userRows.filter((u) => u.role !== "admin").length,
      },
      // Distinct from "never logged in": these accounts predate instrumentation
      // and simply have no observed login, which is not the same claim.
      unknown_login_history: userRows.filter((u) => !u.last_login_at).length,
    },
    tasks_by_source: taskSourceRows.map((r) => ({
      source: r._id || "local",
      tasks: r.tasks,
    })),
    settings: {
      respondents: settingsRows.length,
      // Someone with no settings document has never changed anything. Dropping
      // them would silently shrink the denominator of every bar below.
      on_defaults: userRows.length - settingsRows.length,
      bucketHours: distribution("bucketHours"),
      theme: distribution("theme"),
      snapToRuler: distribution("snapToRuler"),
      tickPercent: distribution("tickPercent"),
    },
    storage: {
      activity_rows: activityCount,
      activity_days_covered: activityDays ? activityDays.n : 0,
    },
  };
}

module.exports = { overview, people, engagement, taskReport, system };
