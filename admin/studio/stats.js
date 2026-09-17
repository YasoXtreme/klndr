// Announcement Studio - one post's numbers: who it was for, who it reached,
// who opened it, and what they did with it.

(() => {
  const S = KlndrStudio;
  const { Rules, h, button, statusPill } = S;
  const C = KlndrCharts;

  function card(title, subtitle, wide) {
    const box = h('section', `an-card${wide ? ' is-wide' : ''}`);
    const head = h('header', 'an-card-head');
    head.appendChild(h('h2', 'an-card-title', title));
    if (subtitle) head.appendChild(h('p', 'an-card-sub', subtitle));
    const body = h('div', 'an-card-body');
    box.append(head, body);
    return { box, body };
  }

  // First opens per local day, from the day it went out (or the first open) to
  // today - at most the last sixty days, so a long-lived post stays readable.
  function opensByDay(a, people) {
    const opened = people.map((p) => p.opened_at).filter(Boolean);
    if (!opened.length) return [];

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const first = new Date(Math.min(a.publish_at || Infinity, ...opened) * 1000);
    first.setHours(0, 0, 0, 0);
    const days = Math.max(1, Math.min(60, Math.round((today - first) / 86400000) + 1));
    const start = new Date(today);
    start.setDate(today.getDate() - (days - 1));

    const buckets = Array.from({ length: days }, (_, i) => {
      const day = new Date(start);
      day.setDate(start.getDate() + i);
      return { key: day.toDateString(), day: S.fmtShortDate(day), opens: 0 };
    });
    const byKey = new Map(buckets.map((bucket) => [bucket.key, bucket]));
    for (const at of opened) {
      const day = new Date(at * 1000);
      day.setHours(0, 0, 0, 0);
      const bucket = byKey.get(day.toDateString());
      if (bucket) bucket.opens += 1;
    }
    return buckets;
  }

  function peopleTable(people, hasButton) {
    const wrap = h('div', 'st-fields');
    const emoji = Object.fromEntries(Rules.REACTIONS.map((r) => [r.id, r.emoji]));
    const openedCount = people.filter((p) => p.opened).length;
    let filter = 'all';

    const table = h('table', 'an-table');
    const headRow = h('tr');
    ['Person', 'Arrived', 'Opened', 'Reaction', ...(hasButton ? ['Clicked'] : [])]
      .forEach((label) => headRow.appendChild(h('th', null, label)));
    const thead = h('thead');
    thead.appendChild(headRow);
    const tbody = h('tbody');
    table.append(thead, tbody);
    const scroll = h('div', 'an-table-scroll');
    scroll.appendChild(table);

    const cell = (text, yes) => {
      const td = h('td');
      td.appendChild(h('span', yes ? 'st-yes' : 'st-no', text));
      return td;
    };

    const renderRows = () => {
      const rows = people
        .filter((p) => filter === 'all' || (filter === 'opened' ? p.opened : !p.opened))
        .sort((x, y) =>
          Number(y.opened) - Number(x.opened) ||
          (y.opened_at || 0) - (x.opened_at || 0) ||
          x.username.localeCompare(y.username));

      tbody.replaceChildren(...rows.map((p) => {
        const tr = h('tr');
        const name = h('td', 'an-cell-name');
        name.append(
          document.createTextNode(`${p.username} `),
          h('span', `role-badge is-${p.role === 'admin' ? 'admin' : 'user'}`, p.role === 'admin' ? 'Admin' : 'Member')
        );
        tr.append(
          name,
          cell(p.delivered ? (p.delivered_at ? S.fmtDateTime(p.delivered_at) : 'Yes') : '-', p.delivered),
          // The old read marker knew that someone had read it, never when.
          cell(p.opened ? (p.opened_at ? S.fmtDateTime(p.opened_at) : 'Before receipts') : '-', p.opened),
          cell(p.reaction ? emoji[p.reaction] || p.reaction : '-', Boolean(p.reaction))
        );
        if (hasButton) tr.appendChild(cell(p.clicked_at ? S.fmtDateTime(p.clicked_at) : '-', Boolean(p.clicked_at)));
        return tr;
      }));

      if (!rows.length) {
        const tr = h('tr');
        const td = h('td', 'is-muted', 'Nobody here.');
        td.colSpan = hasButton ? 5 : 4;
        tr.appendChild(td);
        tbody.appendChild(tr);
      }
    };

    const filters = S.segment(
      [
        { id: 'all', label: `Everyone · ${people.length}` },
        { id: 'opened', label: `Opened · ${openedCount}` },
        { id: 'waiting', label: `Not yet · ${people.length - openedCount}` }
      ],
      filter,
      (id) => {
        filter = id;
        renderRows();
      },
      'Show'
    );

    renderRows();
    wrap.append(filters, scroll);
    return wrap;
  }

  async function openStats(id) {
    S.loadingHeader();
    S.main().replaceChildren(h('p', 'an-loading', 'Counting…'));
    let data;
    try {
      data = await API.getStudioAnnouncement(id);
    } catch (err) {
      S.main().replaceChildren(S.errorBox(err));
      return;
    }
    if (!data || !S.isAt(`/stats/${id}`)) return;

    const a = data.announcement;
    const s = data.stats;
    S.state.view = { name: 'stats', cleanup: null };

    KlndrAdmin.header({
      back: { label: 'All announcements', href: S.href('/') },
      lead: [statusPill(a.studio_status)],
      title: a.title || 'Untitled',
      actions: [
        button('Edit', { icon: 'edit', small: true, onClick: () => S.go(`/edit/${a.id}`) }),
        button('Preview in app', { icon: 'open_in_new', small: true, variant: 'ghost', onClick: () => S.previewInApp(a.id) })
      ],
      documentTitle: `${a.title || 'Untitled'} · Stats`
    });

    const view = h('section', 'st-view');

    if (!a.published_at) {
      view.appendChild(S.note('info', 'hourglass_empty', 'Nothing to count yet - this has not gone out.'));
      S.main().replaceChildren(view);
      return;
    }

    const reactions = s.reactions || {};
    const reacted = Object.values(reactions).reduce((sum, n) => sum + n, 0);
    const favourite = Rules.REACTIONS
      .filter((r) => reactions[r.id])
      .sort((x, y) => reactions[y.id] - reactions[x.id])[0];

    const tiles = h('div', 'an-stats');
    [
      { label: 'Audience', value: String(s.audience), hint: a.evergreen ? 'Everyone, new members too' : 'Here when it went out' },
      { label: 'Arrived', value: String(s.delivered), hint: `${S.fmtPercent(s.delivered, s.audience)} saw it arrive` },
      { label: 'Opened', value: String(s.opened), hint: `${S.fmtPercent(s.opened, s.audience)} of the audience` },
      {
        label: 'Clicked',
        value: a.cta ? String(s.clicked) : '-',
        hint: a.cta ? `${S.fmtPercent(s.clicked, s.audience)} used the button` : 'No button on this post'
      },
      { label: 'Reactions', value: String(reacted), hint: favourite ? `Mostly ${favourite.emoji}` : 'None yet' }
    ].forEach((tile) => tiles.appendChild(C.statTile(tile)));
    view.appendChild(tiles);

    if (s.people.some((p) => p.opened_by_watermark)) {
      const since = s.receipts_since ? `Read receipts started ${S.fmtDateTime(s.receipts_since)}. ` : '';
      view.appendChild(h('p', 'an-note',
        `${since}Some people read this before then. They are counted from the old read marker, which never recorded when, so they show as "Before receipts" and are missing from the chart.`));
    }

    const grid = h('div', 'an-grid');

    const opens = card('Opens by day', `When people first opened it, in ${S.TIMEZONE}.`, true);
    const series = opensByDay(a, s.people);
    opens.body.appendChild(series.length
      ? C.columns({ data: series, labelKey: 'day', valueKey: 'opens', tipLabel: 'opened', wide: true })
      : C.emptyNote('No timed opens yet.'));
    grid.appendChild(opens.box);

    const reactionCard = card(
      'Reactions',
      a.reactions_enabled ? 'One each, and people can change their mind - so this is where they landed.' : 'Reactions are off for this post.'
    );
    reactionCard.body.appendChild(reacted
      ? C.hbar({ rows: Rules.REACTIONS.map((r) => ({ label: `${r.emoji} ${r.label}`, value: reactions[r.id] || 0 })), series: 2 })
      : C.emptyNote('No reactions yet.'));
    grid.appendChild(reactionCard.box);

    const arrival = card('How it went out', null);
    const facts = h('dl', 'an-facts');
    const fact = (label, value) => facts.append(h('dt', null, label), h('dd', null, value));
    fact('Delivery', S.deliveryLabel(a.delivery));
    fact('Audience', S.audienceLabel(a));
    fact('Went out', S.fmtDateTime(a.publish_at));
    if (a.redelivered_at) fact('Sent again', S.fmtDateTime(a.redelivered_at));
    if (a.expires_at) fact(a.studio_status === 'expired' ? 'Expired' : 'Comes down', S.fmtDateTime(a.expires_at));
    fact('Kind', Rules.kind(a.kind).label);
    arrival.body.appendChild(facts);
    grid.appendChild(arrival.box);

    const peopleCard = card('People', 'Everyone this post was for, and what reached them.', true);
    peopleCard.body.appendChild(s.people.length
      ? peopleTable(s.people, Boolean(a.cta))
      : C.emptyNote('Nobody is in this audience.'));
    grid.appendChild(peopleCard.box);

    view.appendChild(grid);
    S.main().replaceChildren(view);
  }

  S.routes.stats = openStats;
})();
