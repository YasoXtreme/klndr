// Analytics page controller.
//
// Tabs fetch on first entry rather than on load, the same lazy-loader shape
// KlndrApp.switchAccountTab uses for the account modal: five reports up front
// would run five sets of aggregations for four tabs nobody has opened.
//
// The recurring job of this file is to render what is NOT known as carefully as
// what is. klndr recorded nothing temporal before this feature shipped, so a
// missing number means "we were not watching yet", never "zero" - and every
// place that distinction exists, it is spelled out on screen.

(() => {
  const C = KlndrCharts;

  const state = { days: 90, cache: new Map(), loading: new Set() };

  const SECTIONS = {
    panelOverview: { key: "overview", render: renderOverview },
    panelPeople: { key: "users", render: renderPeople },
    panelEngagement: { key: "engagement", render: renderEngagement },
    panelTasks: { key: "tasks", render: renderTasks },
    panelSystem: { key: "system", render: renderSystem },
  };

  // $dayOfWeek is 1 = Sunday through 7 = Saturday.
  const DOW = ["", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const HOURS = Array.from({ length: 24 }, (_, i) => ({
    key: i,
    label: String(i).padStart(2, "0"),
  }));

  const BADGES = {
    today: ["Today", "ok"],
    this_week: ["This week", "ok"],
    this_month: ["This month", "warn"],
    dormant: ["Dormant", "danger"],
    unknown: ["Not observed", "muted"],
  };

  // ---- small DOM helpers --------------------------------------------------

  function h(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function card(title, subtitle, options = {}) {
    const box = h("section", "an-card" + (options.wide ? " is-wide" : ""));
    const head = h("header", "an-card-head");
    head.appendChild(h("h2", "an-card-title", title));
    if (subtitle) head.appendChild(h("p", "an-card-sub", subtitle));
    box.appendChild(head);
    const body = h("div", "an-card-body");
    box.appendChild(body);
    return { box, body };
  }

  function grid(className) {
    return h("div", className || "an-grid");
  }

  /**
   * The standing caveat on anything time-based.
   *
   * Rendered rather than merely returned by the API: a chart that silently
   * omits everything older than the instrumentation date is not incomplete, it
   * is misleading, and the sentence explaining that has to be next to it.
   */
  function coverageNote(meta, kind) {
    const since = meta.instrumented_since[kind];
    const note = h("p", "an-note");
    if (since == null) {
      note.classList.add("is-warn");
      note.textContent =
        "Not recording yet - this chart fills in once the first one is written.";
      return note;
    }
    note.textContent = `Recorded since ${C.fmtDate(since)}. Anything earlier was never measured.`;
    return note;
  }

  function statRow(tiles) {
    const row = h("div", "an-stats");
    tiles.forEach((t) => row.appendChild(C.statTile(t)));
    return row;
  }

  // ---- loading ------------------------------------------------------------

  async function show(panelId, { force = false } = {}) {
    document.querySelectorAll(".an-tab").forEach((b) => {
      b.classList.toggle("active", b.dataset.panel === panelId);
      b.setAttribute("aria-selected", b.dataset.panel === panelId ? "true" : "false");
    });
    document.querySelectorAll(".an-panel").forEach((p) => {
      p.hidden = p.id !== panelId;
    });

    const section = SECTIONS[panelId];
    const panel = document.getElementById(panelId);
    const cacheKey = `${section.key}:${state.days}`;

    if (!force && state.cache.has(cacheKey)) {
      paint(panel, section, state.cache.get(cacheKey));
      return;
    }
    if (state.loading.has(cacheKey)) return;
    state.loading.add(cacheKey);

    panel.replaceChildren(h("p", "an-loading", "Working it out…"));
    try {
      const data = await API.getAnalytics(section.key, state.days);
      if (!data) return; // request() already redirected on a 401
      state.cache.set(cacheKey, data);
      paint(panel, section, data);
    } catch (err) {
      panel.replaceChildren(errorBox(err));
    } finally {
      state.loading.delete(cacheKey);
    }
  }

  function paint(panel, section, data) {
    panel.replaceChildren();
    section.render(panel, data);
    panel.appendChild(generatedNote(data.meta));
  }

  function errorBox(err) {
    const box = h("div", "an-error");
    // Being signed in as the wrong person is not the same as being signed out,
    // and bouncing to /login would just bounce straight back.
    box.appendChild(
      h(
        "p",
        null,
        err && err.status === 403
          ? "This page is for admins. Your account does not have access."
          : "Could not load this section.",
      ),
    );
    if (err && err.message && err.status !== 403) {
      box.appendChild(h("p", "an-error-detail", err.message));
    }
    return box;
  }

  function generatedNote(meta) {
    return h(
      "p",
      "an-generated",
      `Generated ${C.fmtAgo(meta.generated_at)} · times in ${meta.tz} · ${meta.range.days}-day range`,
    );
  }

  // ---- 1. OVERVIEW --------------------------------------------------------

  function renderOverview(panel, d) {
    panel.appendChild(
      statRow([
        { label: "Accounts", value: d.totals.users, hint: `${d.totals.admins} admin` },
        { label: "Active today", value: d.activity.dau, hint: `${d.activity.wau} this week` },
        { label: "Active this month", value: d.activity.mau, hint: `stickiness ${d.activity.stickiness}` },
        { label: "Tasks", value: C.fmt(d.totals.tasks), hint: `${d.totals.scheduled_tasks} scheduled` },
        {
          label: "Completion rate",
          value: Math.round(d.totals.completion_rate * 100) + "%",
          hint: `${d.totals.completed_tasks} done`,
        },
        { label: "Tasks per account", value: d.totals.avg_tasks_per_user },
      ]),
    );

    const wrap = grid();

    const signups = card(
      "Accounts provisioned",
      "klndr has no self-signup, so this is when an admin created each account - not when anyone chose to join.",
      { wide: true },
    );
    signups.body.appendChild(
      C.columns({ data: d.signups, labelKey: "week", valueKey: "count", series: 0, tipLabel: "accounts", wide: true }),
    );
    wrap.appendChild(signups.box);

    const created = card("Tasks created", "By week.", { wide: true });
    created.body.appendChild(
      C.columns({ data: d.tasks_created, labelKey: "week", valueKey: "count", series: 2, tipLabel: "tasks", wide: true }),
    );
    created.body.appendChild(coverageNote(d.meta, "task_created_at"));
    if (d.meta.coverage.tasks_pre_instrumentation > 0) {
      created.body.appendChild(
        h(
          "p",
          "an-note is-warn",
          `${C.fmt(d.meta.coverage.tasks_pre_instrumentation)} of ${C.fmt(d.meta.coverage.tasks_total)} tasks predate instrumentation and are counted in the totals above but cannot appear on this chart.`,
        ),
      );
    }
    wrap.appendChild(created.box);

    const health = card("Needs attention", "Things an admin would want to act on.");
    const rows = [
      ["Password resets pending", d.health.must_change_password],
      ["Integrations needing reauth", d.health.integrations_reauth_required],
      ["Integrations reporting an error", d.health.integrations_with_error],
    ];
    const list = h("ul", "an-health");
    rows.forEach(([label, value]) => {
      const li = h("li", value > 0 ? "is-flagged" : null);
      li.appendChild(h("span", null, label));
      li.appendChild(h("strong", null, String(value)));
      list.appendChild(li);
    });
    health.body.appendChild(list);
    wrap.appendChild(health.box);

    const mix = card("Task mix", "Everything ever created, by state.");
    mix.body.appendChild(
      C.donut({
        slices: [
          { label: "Scheduled", value: d.totals.scheduled_tasks },
          { label: "Unscheduled", value: d.totals.unscheduled_tasks },
        ],
        centreValue: C.fmt(d.totals.tasks),
        centreLabel: "tasks",
      }),
    );
    wrap.appendChild(mix.box);

    panel.appendChild(wrap);
  }

  // ---- 2. PEOPLE ----------------------------------------------------------

  const PEOPLE_COLUMNS = [
    { key: "username", label: "Account", get: (u) => u.username },
    { key: "role", label: "Role", get: (u) => u.role },
    { key: "active_badge", label: "Status", get: (u) => u.active_badge },
    { key: "last_seen_at", label: "Last seen", get: (u) => u.last_seen_at || 0 },
    { key: "last_login_at", label: "Last login", get: (u) => u.last_login_at || 0 },
    { key: "login_count", label: "Logins", get: (u) => (u.login_count == null ? -1 : u.login_count) },
    { key: "created_at", label: "Created", get: (u) => u.created_at },
    { key: "tasks", label: "Tasks", get: (u) => u.tasks.total },
    { key: "scheduled", label: "Scheduled", get: (u) => u.tasks.scheduled },
    { key: "completed", label: "Done", get: (u) => u.tasks.completed },
    { key: "rate", label: "Rate", get: (u) => u.tasks.completion_rate },
    { key: "categories", label: "Cats", get: (u) => u.categories.count },
    { key: "streak", label: "Streak", get: (u) => u.activity.current_streak },
    { key: "sessions", label: "Sessions", get: (u) => u.live_sessions },
  ];

  let peopleSort = { key: "last_seen_at", dir: -1 };

  function renderPeople(panel, d) {
    const active = d.users.filter((u) => u.active_badge === "today" || u.active_badge === "this_week");
    panel.appendChild(
      statRow([
        { label: "Accounts", value: d.users.length },
        { label: "Active this week", value: active.length },
        {
          label: "Never observed",
          value: d.users.filter((u) => u.active_badge === "unknown").length,
          hint: "predate tracking",
        },
        {
          label: "Resets pending",
          value: d.users.filter((u) => u.must_change_password).length,
        },
      ]),
    );

    const box = card(
      "Accounts",
      "Counts and timings only. No task titles, and no category names - those are the account holder's own words.",
      { wide: true },
    );

    const table = h("table", "an-table");
    const thead = h("thead");
    const hr = h("tr");
    PEOPLE_COLUMNS.forEach((col) => {
      const th = h("th", "is-sortable", col.label);
      th.addEventListener("click", () => {
        peopleSort =
          peopleSort.key === col.key
            ? { key: col.key, dir: -peopleSort.dir }
            : { key: col.key, dir: -1 };
        renderPeopleRows(tbody, d.users);
        markSort(hr);
      });
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = h("tbody");
    table.appendChild(tbody);
    renderPeopleRows(tbody, d.users);
    markSort(hr);

    const scroll = h("div", "an-table-scroll");
    scroll.appendChild(table);
    box.body.appendChild(scroll);
    panel.appendChild(box.box);

    const detail = h("div", "an-detail", "Select an account to see its shape.");
    detail.id = "peopleDetail";
    panel.appendChild(detail);
  }

  function markSort(headRow) {
    [...headRow.children].forEach((th, i) => {
      const col = PEOPLE_COLUMNS[i];
      th.classList.toggle("is-sorted", col.key === peopleSort.key);
      th.dataset.dir = col.key === peopleSort.key ? (peopleSort.dir > 0 ? "asc" : "desc") : "";
    });
  }

  function renderPeopleRows(tbody, users) {
    const col = PEOPLE_COLUMNS.find((c) => c.key === peopleSort.key);
    const sorted = [...users].sort((a, b) => {
      const av = col.get(a);
      const bv = col.get(b);
      if (typeof av === "string") return av.localeCompare(bv) * peopleSort.dir;
      return (av - bv) * peopleSort.dir;
    });

    tbody.replaceChildren();
    sorted.forEach((u) => {
      const tr = h("tr");
      tr.appendChild(h("td", "an-cell-name", u.username));

      const roleCell = h("td");
      roleCell.appendChild(h("span", "role-badge is-" + u.role, u.role));
      tr.appendChild(roleCell);

      const badgeCell = h("td");
      const [label, tone] = BADGES[u.active_badge] || ["—", "muted"];
      badgeCell.appendChild(h("span", "an-badge is-" + tone, label));
      tr.appendChild(badgeCell);

      tr.appendChild(h("td", null, u.last_seen_at ? C.fmtAgo(u.last_seen_at) : "—"));

      const loginCell = h("td", null, u.last_login_at ? C.fmtAgo(u.last_login_at) : "—");
      if (u.last_login_source === "session") {
        // Inferred from a surviving session row rather than observed. Marked,
        // because a logout deletes the evidence and this would silently vanish.
        loginCell.appendChild(h("span", "an-inferred", "~"));
        loginCell.title =
          "Inferred from a still-valid session, not an observed login. Logging out erases this.";
      }
      tr.appendChild(loginCell);

      const countCell = h("td", null, u.login_count == null ? "—" : String(u.login_count));
      if (u.login_count == null) {
        countCell.title = "Not recoverable for accounts that predate login tracking.";
      }
      tr.appendChild(countCell);

      tr.appendChild(h("td", null, C.fmtDate(u.created_at)));
      tr.appendChild(h("td", null, String(u.tasks.total)));
      tr.appendChild(h("td", null, String(u.tasks.scheduled)));
      tr.appendChild(h("td", null, String(u.tasks.completed)));
      tr.appendChild(
        h("td", null, u.tasks.total ? Math.round(u.tasks.completion_rate * 100) + "%" : "—"),
      );

      const catCell = h("td", null, String(u.categories.count));
      if (u.categories.state === "unmigrated") {
        catCell.classList.add("is-muted");
        catCell.title = "This account predates categories and has not been migrated yet.";
      }
      tr.appendChild(catCell);

      tr.appendChild(h("td", null, u.activity.current_streak ? u.activity.current_streak + "d" : "—"));
      tr.appendChild(h("td", null, String(u.live_sessions)));

      tr.addEventListener("click", () => {
        document.querySelectorAll(".an-table tbody tr").forEach((r) => r.classList.remove("is-selected"));
        tr.classList.add("is-selected");
        renderPersonDetail(u);
      });
      tbody.appendChild(tr);
    });
  }

  function renderPersonDetail(u) {
    const host = document.getElementById("peopleDetail");
    host.replaceChildren();
    host.classList.add("is-open");

    const head = h("div", "an-detail-head");
    head.appendChild(h("h3", null, u.username));
    head.appendChild(
      h(
        "span",
        "an-detail-meta",
        `provisioned ${C.fmtDate(u.created_at)} · ${u.activity.days_active_30} active days in the last 30 · longest streak ${u.activity.longest_streak || 0}d`,
      ),
    );
    host.appendChild(head);

    const wrap = grid("an-grid");

    const mix = card("Task mix", "This account only.");
    if (u.tasks.total) {
      mix.body.appendChild(
        C.donut({
          slices: [
            { label: "Scheduled, open", value: Math.max(0, u.tasks.scheduled - u.tasks.completed) },
            { label: "Unscheduled", value: u.tasks.unscheduled },
            { label: "Completed", value: u.tasks.completed },
          ],
          centreValue: String(u.tasks.total),
          centreLabel: "tasks",
        }),
      );
    } else {
      mix.body.appendChild(C.emptyNote("No tasks yet."));
    }
    wrap.appendChild(mix.box);

    const facts = card("Account", null);
    const dl = h("dl", "an-facts");
    const add = (label, value, title) => {
      dl.appendChild(h("dt", null, label));
      const dd = h("dd", null, value);
      if (title) dd.title = title;
      dl.appendChild(dd);
    };
    add("Role", u.role);
    add("Status", (BADGES[u.active_badge] || ["—"])[0]);
    add("Last seen", u.last_seen_at ? C.fmtAgo(u.last_seen_at) : "—");
    add(
      "Last login",
      u.last_login_at ? C.fmtAgo(u.last_login_at) : "—",
      u.last_login_source === "session" ? "Inferred from a live session." : undefined,
    );
    add("Logins recorded", u.login_count == null ? "—" : String(u.login_count));
    add("Live sessions", String(u.live_sessions));
    add("Planned time", C.fmtMinutes(u.tasks.planned_minutes));
    add("Imported tasks", String(u.tasks.imported));
    add("Uncategorised", String(u.tasks.uncategorised));
    add("Categories", `${u.categories.count} (${u.categories.state})`);
    add("Time on app (30d)", C.fmtMinutes(u.activity.active_minutes_30) + " approx.",
      "Five-minute presence windows, not measured session length.");
    add("Unread announcements", String(u.announcements.unread));
    facts.body.appendChild(dl);
    wrap.appendChild(facts.box);

    if (u.integrations.length) {
      const int = card("Integrations", null);
      int.body.appendChild(
        C.hbar({
          rows: u.integrations.map((i) => ({
            label: `${i.provider} · ${i.status}`,
            value: i.last_synced_at ? 1 : 0,
          })),
          format: () => "",
        }),
      );
      const list = h("ul", "an-plain-list");
      u.integrations.forEach((i) => {
        list.appendChild(
          h(
            "li",
            i.has_error ? "is-flagged" : null,
            `${i.provider}: ${i.status}${i.last_synced_at ? ", synced " + C.fmtAgo(i.last_synced_at) : ", never synced"}${i.has_error ? " (error)" : ""}`,
          ),
        );
      });
      int.body.replaceChildren(list);
      wrap.appendChild(int.box);
    }

    host.appendChild(wrap);
    host.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  // ---- 3. ENGAGEMENT ------------------------------------------------------

  function renderEngagement(panel, d) {
    const latest = d.series[d.series.length - 1] || { dau: 0, wau: 0, mau: 0, stickiness: 0 };
    panel.appendChild(
      statRow([
        { label: "Active today", value: latest.dau },
        { label: "Active this week", value: latest.wau },
        { label: "Active this month", value: latest.mau },
        {
          label: "Stickiness",
          value: latest.mau ? Math.round(latest.stickiness * 100) + "%" : "—",
          hint: "daily ÷ monthly",
        },
        {
          label: "Never activated",
          value: d.activation.never_activated,
          hint: "provisioned, never seen",
        },
        {
          label: "Median time to first use",
          value: d.activation.median_hours_to_first_seen == null
            ? "—"
            : C.fmtMinutes(d.activation.median_hours_to_first_seen * 60),
        },
      ]),
    );

    const wrap = grid();

    const series = card("Active accounts", "Rolling daily, weekly and monthly.", { wide: true });
    series.body.appendChild(
      C.lines({
        data: d.series,
        labelKey: "day",
        series: [
          { key: "dau", label: "Daily" },
          { key: "wau", label: "Weekly" },
          { key: "mau", label: "Monthly" },
        ],
        wide: true,
      }),
    );
    series.body.appendChild(coverageNote(d.meta, "activity"));
    wrap.appendChild(series.box);

    const nvr = card("New vs returning", "By week of first-ever activity.", { wide: true });
    nvr.body.appendChild(
      C.stacked({
        data: d.new_vs_returning,
        labelKey: "week",
        series: [
          { key: "new", label: "First time" },
          { key: "returning", label: "Returning" },
        ],
        wide: true,
      }),
    );
    wrap.appendChild(nvr.box);

    const heat = card(
      "When klndr gets used",
      `Pooled across everyone, in ${d.meta.tz}.`,
      { wide: true },
    );
    heat.body.appendChild(
      C.heatmap({
        cells: d.heatmap.cells.map((c) => ({
          row: c.dow,
          col: c.hour,
          rowLabel: DOW[c.dow],
          colLabel: String(c.hour).padStart(2, "0"),
          value: c.pings,
        })),
        rows: [1, 2, 3, 4, 5, 6, 7].map((n) => ({ key: n, label: DOW[n] })),
        cols: HOURS,
        rowLabel: "Day",
        colLabel: "hour",
        valueLabel: "presence windows",
      }),
    );
    wrap.appendChild(heat.box);

    const retention = card(
      "Retention",
      "By the week the account was provisioned. Only cohorts formed after tracking began appear - a cohort spanning that line would read as total churn.",
      { wide: true },
    );
    retention.body.appendChild(renderRetention(d.retention));
    wrap.appendChild(retention.box);

    const streaks = card("Longest streaks", "Consecutive days with any activity.");
    streaks.body.appendChild(
      d.streaks.top.length
        ? C.hbar({
            rows: d.streaks.top.map((s) => ({
              label: s.username,
              value: s.longest,
              hint: `current ${s.current}d`,
            })),
            suffix: "d",
          })
        : C.emptyNote("No streaks recorded yet."),
    );
    wrap.appendChild(streaks.box);

    const proxy = card("Time on app", "A proxy, not a measurement.");
    proxy.body.appendChild(
      C.statTile({
        label: "Median per active day",
        value: C.fmtMinutes(d.time_proxy.median_active_minutes_per_day),
      }),
    );
    proxy.body.appendChild(
      h(
        "p",
        "an-note",
        "klndr has no logout beacon, so real session length is not observable. This counts five-minute windows in which someone was present and multiplies - it will understate a long reading session and overstate a quick check.",
      ),
    );
    wrap.appendChild(proxy.box);

    panel.appendChild(wrap);
  }

  function renderRetention(retention) {
    if (!retention.cohorts.length) {
      return C.emptyNote(
        "No cohorts yet. A cohort appears once an account is provisioned after tracking began.",
      );
    }
    const width = Math.max(...retention.cohorts.map((c) => c.cells.length));
    const table = h("table", "an-cohort");
    const thead = h("thead");
    const hr = h("tr");
    hr.appendChild(h("th", null, "Provisioned"));
    hr.appendChild(h("th", null, "Accounts"));
    for (let i = 0; i < width; i++) hr.appendChild(h("th", null, "wk " + i));
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = h("tbody");
    retention.cohorts.forEach((cohort) => {
      const tr = h("tr");
      tr.appendChild(h("td", null, cohort.cohort));
      tr.appendChild(h("td", null, String(cohort.size)));
      const byWeek = new Map(cohort.cells.map((c) => [c.week, c.users]));
      for (let i = 0; i < width; i++) {
        const users = byWeek.get(i);
        const td = h("td", "an-cohort-cell");
        if (users == null) {
          td.textContent = "";
          td.classList.add("is-empty");
        } else {
          const share = cohort.size ? users / cohort.size : 0;
          td.textContent = Math.round(share * 100) + "%";
          td.style.background = `var(--chart-seq-${Math.min(5, Math.max(1, Math.ceil(share * 5)))})`;
          td.title = `${users} of ${cohort.size}`;
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    const scroll = h("div", "an-table-scroll");
    scroll.appendChild(table);
    return scroll;
  }

  // ---- 4. PLANNING & TASKS ------------------------------------------------

  function renderTasks(panel, d) {
    panel.appendChild(
      statRow([
        { label: "Tasks", value: C.fmt(d.totals.tasks) },
        { label: "Scheduled", value: C.fmt(d.totals.scheduled), hint: `${C.fmt(d.totals.unscheduled)} unscheduled` },
        { label: "Completed", value: C.fmt(d.totals.completed), hint: Math.round(d.totals.completion_rate * 100) + "%" },
        { label: "Planned time", value: C.fmtMinutes(d.totals.planned_minutes) },
        { label: "Imported", value: C.fmt(d.totals.imported), hint: `${C.fmt(d.totals.local)} made here` },
        { label: "Uncategorised", value: C.fmt(d.totals.uncategorised) },
      ]),
    );

    const wrap = grid();

    const split = card("Scheduled or not", "A task with no block is still a task.");
    split.body.appendChild(
      C.donut({
        slices: [
          { label: "Scheduled", value: d.totals.scheduled },
          { label: "Unscheduled", value: d.totals.unscheduled },
        ],
        centreValue: C.fmt(d.totals.tasks),
        centreLabel: "tasks",
      }),
    );
    wrap.appendChild(split.box);

    const done = card("Done or open", null);
    done.body.appendChild(
      C.donut({
        slices: [
          { label: "Completed", value: d.totals.completed },
          { label: "Open", value: d.totals.open },
        ],
        centreValue: Math.round(d.totals.completion_rate * 100) + "%",
        centreLabel: "complete",
      }),
    );
    wrap.appendChild(done.box);

    const locked = card("Locked or free", "Locked blocks are pushed, not compressed.");
    locked.body.appendChild(
      C.donut({
        slices: [
          { label: "Locked", value: d.totals.locked },
          { label: "Unlocked", value: d.totals.unlocked },
        ],
      }),
    );
    wrap.appendChild(locked.box);

    const segments = card(
      "Blocks per task",
      "klndr's whole premise is that one task can be several blocks. This is whether anyone actually splits them.",
      { wide: true },
    );
    segments.body.appendChild(
      C.columns({
        data: d.segments_per_task.map((s) => ({
          label: s.segments === 0 ? "unscheduled" : s.segments + " block" + (s.segments === 1 ? "" : "s"),
          tasks: s.tasks,
        })),
        labelKey: "label",
        valueKey: "tasks",
        series: 6,
        tipLabel: "tasks",
        wide: true,
      }),
    );
    wrap.appendChild(segments.box);

    const duration = card("How long a task is", "By its total planned duration.", { wide: true });
    duration.body.appendChild(
      C.columns({
        data: d.duration_histogram.map((b) => ({ label: C.fmtMinutes(b.from) + "+", tasks: b.tasks })),
        labelKey: "label",
        valueKey: "tasks",
        series: 3,
        tipLabel: "tasks",
        wide: true,
      }),
    );
    wrap.appendChild(duration.box);

    const weekday = card("When work is planned", "Planned minutes by weekday.", { wide: true });
    weekday.body.appendChild(
      C.columns({
        data: d.planned_by_weekday.map((r) => ({ label: DOW[r.dow], minutes: r.minutes })),
        labelKey: "label",
        valueKey: "minutes",
        series: 1,
        format: C.fmtMinutes,
        wide: true,
      }),
    );
    wrap.appendChild(weekday.box);

    const hour = card(
      "What hours get planned",
      "Each block is spread across the hours it actually occupies, not filed under the hour it starts.",
      { wide: true },
    );
    hour.body.appendChild(
      C.columns({
        data: d.planned_by_hour.map((r) => ({ label: String(r.hour).padStart(2, "0"), minutes: r.minutes })),
        labelKey: "label",
        valueKey: "minutes",
        series: 1,
        format: C.fmtMinutes,
        wide: true,
      }),
    );
    wrap.appendChild(hour.box);

    const completed = card("Tasks completed", "By week.", { wide: true });
    completed.body.appendChild(
      C.columns({
        data: d.completed_over_time,
        labelKey: "week",
        valueKey: "count",
        series: 5,
        tipLabel: "tasks",
        wide: true,
      }),
    );
    completed.body.appendChild(coverageNote(d.meta, "task_completed_at"));
    wrap.appendChild(completed.box);

    const latency = card(
      "How long a task waits",
      `From creation to completion. ${d.completion_latency.sample} measurable, median ${d.completion_latency.median_hours == null ? "—" : C.fmtMinutes(d.completion_latency.median_hours * 60)}.`,
      { wide: true },
    );
    latency.body.appendChild(
      d.completion_latency.sample
        ? C.columns({
            data: d.completion_latency.buckets.map((b) => ({
              label: C.fmtMinutes(b.from_hours * 60) + "+",
              tasks: b.tasks,
            })),
            labelKey: "label",
            valueKey: "tasks",
            series: 7,
            tipLabel: "tasks",
            wide: true,
          })
        : C.emptyNote(
            "Needs both a creation and a completion timestamp, so this fills in for tasks created from now on.",
          ),
    );
    wrap.appendChild(latency.box);

    const cats = card(
      "Shared categories",
      "Only names that at least two different people use. A category one person made is their own words and is counted but never shown.",
      { wide: true },
    );
    cats.body.appendChild(
      d.top_categories.length
        ? C.hbar({
            rows: d.top_categories.map((c) => ({
              label: c.name,
              value: c.tasks,
              hint: `${c.users} accounts`,
            })),
            series: 4,
          })
        : C.emptyNote("No category name is shared by two accounts yet."),
    );
    wrap.appendChild(cats.box);

    const perUser = card("Categories per account", null);
    perUser.body.appendChild(
      C.columns({
        data: d.categories_per_user.distribution.map((r) => ({
          label: String(r.categories),
          users: r.users,
        })),
        labelKey: "label",
        valueKey: "users",
        series: 2,
        tipLabel: "accounts",
      }),
    );
    if (d.categories_per_user.unmigrated) {
      perUser.body.appendChild(
        h(
          "p",
          "an-note",
          `${d.categories_per_user.unmigrated} account(s) predate categories and are not counted here - the absence of a category list is what marks them as unmigrated.`,
        ),
      );
    }
    wrap.appendChild(perUser.box);

    panel.appendChild(wrap);
  }

  // ---- 5. SYSTEM & HEALTH -------------------------------------------------

  function renderSystem(panel, d) {
    panel.appendChild(
      statRow([
        { label: "Accounts", value: d.accounts.roles.admin + d.accounts.roles.user, hint: `${d.accounts.roles.admin} admin` },
        { label: "Valid sessions", value: d.sessions.live, hint: `${d.sessions.accounts_with_live_session} accounts` },
        { label: "Resets pending", value: d.accounts.must_change_password },
        { label: "Activity rows", value: C.fmt(d.storage.activity_rows), hint: `${d.storage.activity_days_covered} days` },
      ]),
    );

    const wrap = grid();

    const sessions = card("Sessions", null);
    sessions.body.appendChild(
      d.sessions.per_user_histogram.length
        ? C.hbar({
            rows: d.sessions.per_user_histogram.map((r) => ({
              label: r.sessions + " session" + (r.sessions === 1 ? "" : "s"),
              value: r.users,
            })),
            suffix: " accounts",
          })
        : C.emptyNote("No valid sessions."),
    );
    // The caveat is rendered, not just carried in the payload.
    sessions.body.appendChild(h("p", "an-note is-warn", d.sessions.note));
    wrap.appendChild(sessions.box);

    const integrations = card("Integrations", null);
    if (d.integrations.by_provider.length) {
      const list = h("ul", "an-plain-list");
      d.integrations.by_provider.forEach((p) => {
        const li = h("li", p.reauth_required || p.with_error ? "is-flagged" : null);
        li.textContent = `${p.provider}: ${p.connected} connected, ${p.reauth_required} need reauth, ${p.with_error} with errors, ${p.never_synced} never synced${p.median_hours_since_sync == null ? "" : `, median sync ${C.fmtMinutes(p.median_hours_since_sync * 60)} ago`}`;
        list.appendChild(li);
      });
      integrations.body.appendChild(list);
    } else {
      integrations.body.appendChild(C.emptyNote("Nobody has connected an integration."));
    }
    wrap.appendChild(integrations.box);

    const source = card("Where tasks come from", null);
    source.body.appendChild(
      C.donut({
        slices: d.tasks_by_source.map((s) => ({ label: s.source, value: s.tasks })),
      }),
    );
    wrap.appendChild(source.box);

    const announcements = card(
      "Announcements",
      "Cumulative: dismissing one marks every earlier announcement seen, so this is 'read at least this far', not an open rate.",
      { wide: true },
    );
    announcements.body.appendChild(
      d.announcements.length
        ? C.hbar({
            rows: d.announcements.map((a) => ({
              label: `#${a.id} ${a.title}`,
              value: a.read_through,
              hint: `${Math.round(a.rate * 100)}% of ${a.eligible}`,
            })),
            suffix: " accounts",
            series: 3,
          })
        : C.emptyNote("No announcements yet."),
    );
    wrap.appendChild(announcements.box);

    const settings = card(
      "Settings",
      `${d.settings.on_defaults} account(s) have never changed a setting and are counted as defaults.`,
      { wide: true },
    );
    const sgrid = h("div", "an-subgrid");
    [
      ["Snap bucket (hours)", d.settings.bucketHours],
      ["Theme", d.settings.theme],
      ["Snap to ruler", d.settings.snapToRuler],
      ["Tick percent", d.settings.tickPercent],
    ].forEach(([label, rows]) => {
      const sub = h("div", "an-sub");
      sub.appendChild(h("h3", "an-sub-title", label));
      sub.appendChild(
        rows.length
          ? C.hbar({ rows: rows.map((r) => ({ label: r.value, value: r.users })), series: 0 })
          : C.emptyNote("No answers."),
      );
      sgrid.appendChild(sub);
    });
    settings.body.appendChild(sgrid);
    wrap.appendChild(settings.box);

    const accounts = card("Login history", null);
    accounts.body.appendChild(
      h(
        "p",
        "an-note",
        `${d.accounts.unknown_login_history} account(s) have no observed login. That means they predate login tracking, not that they have never signed in.`,
      ),
    );
    wrap.appendChild(accounts.box);

    panel.appendChild(wrap);
  }

  // ---- boot ---------------------------------------------------------------

  function init() {
    if (window.KlndrTheme && KlndrTheme.mount) KlndrTheme.mount();

    document.querySelectorAll(".an-tab").forEach((btn) => {
      btn.addEventListener("click", () => show(btn.dataset.panel));
    });

    const range = document.getElementById("anRange");
    range.value = String(state.days);
    range.addEventListener("change", () => {
      state.days = Number(range.value);
      const open = document.querySelector(".an-tab.active");
      if (open) show(open.dataset.panel);
    });

    document.getElementById("anRefresh").addEventListener("click", () => {
      const open = document.querySelector(".an-tab.active");
      if (open) show(open.dataset.panel, { force: true });
    });

    show("panelOverview");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
