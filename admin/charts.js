// Hand-drawn SVG charts.
//
// No library, because klndr's client is deliberately dependency-free and has no
// build step - Chart.js would be the only vendored JS in the repository.
//
// Everything is coloured through CSS custom properties (fill="var(--chart-1)"),
// which is the real reason to prefer SVG over canvas here: the theme toggle
// recolours every chart with no re-render, no getComputedStyle palette cache and
// no klndr:themechange listener, all of which TimelineCanvas needs precisely
// because a canvas cannot see a variable.
//
// Two rules from the palette work carry into every function below.
//   - Series colours are assigned in FIXED ORDER and never cycled. Slot 1 is
//     always slot 1, so hiding a series never repaints the others.
//   - Three light-mode steps sit under 3:1 against white, so every chart ships
//     either direct labels or a table view. That relief is a requirement.

const KlndrCharts = (() => {
  const NS = "http://www.w3.org/2000/svg";
  const SERIES = (i) => `var(--chart-${(i % 8) + 1})`;

  function el(tag, attrs = {}, kids = []) {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined) continue;
      node.setAttribute(k, String(v));
    }
    for (const kid of [].concat(kids)) {
      if (kid) node.appendChild(kid);
    }
    return node;
  }

  function h(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // ---- formatting ---------------------------------------------------------

  const fmt = (n) =>
    n === null || n === undefined || Number.isNaN(n)
      ? "—"
      : Math.abs(n) >= 10000
        ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "k"
        : String(Math.round(n * 100) / 100);

  function fmtMinutes(m) {
    if (m === null || m === undefined) return "—";
    if (m < 60) return Math.round(m) + "m";
    const hours = m / 60;
    if (hours < 24) return hours.toFixed(1).replace(/\.0$/, "") + "h";
    return Math.round(hours / 24) + "d";
  }

  function fmtDate(ts) {
    if (!ts) return "—";
    return new Date(ts * 1000).toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  }

  function fmtAgo(ts) {
    if (!ts) return "—";
    const seconds = Math.floor(Date.now() / 1000) - ts;
    if (seconds < 90) return "just now";
    const mins = Math.round(seconds / 60);
    if (mins < 60) return mins + "m ago";
    const hours = Math.round(mins / 60);
    if (hours < 36) return hours + "h ago";
    return Math.round(hours / 24) + "d ago";
  }

  // ---- shared hover layer -------------------------------------------------

  let tip;
  function tipNode() {
    if (!tip) {
      tip = h("div", "chart-tip");
      tip.hidden = true;
      document.body.appendChild(tip);
    }
    return tip;
  }

  // Hit targets are the mark plus padding, never the mark alone - a 3px column
  // is not a pointer target.
  function bindTip(node, html) {
    node.addEventListener("pointerenter", (event) => {
      const t = tipNode();
      t.innerHTML = html;
      t.hidden = false;
      move(event);
    });
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerleave", () => {
      if (tip) tip.hidden = true;
    });
    function move(event) {
      const t = tipNode();
      const pad = 14;
      let x = event.clientX + pad;
      let y = event.clientY + pad;
      const box = t.getBoundingClientRect();
      if (x + box.width > window.innerWidth - 8) x = event.clientX - box.width - pad;
      if (y + box.height > window.innerHeight - 8) y = event.clientY - box.height - pad;
      t.style.left = x + "px";
      t.style.top = y + "px";
    }
  }

  // ---- chart shell --------------------------------------------------------

  function root(width, height) {
    const svg = el("svg", {
      viewBox: `0 0 ${width} ${height}`,
      preserveAspectRatio: "xMidYMid meet",
      class: "chart-svg",
      role: "img",
    });
    return svg;
  }

  function legend(items) {
    const box = h("div", "chart-legend");
    items.forEach((item, i) => {
      const row = h("span", "chart-legend-item");
      const dot = h("span", "chart-legend-dot");
      dot.style.background = item.color || SERIES(i);
      row.appendChild(dot);
      row.appendChild(h("span", null, item.label));
      box.appendChild(row);
    });
    return box;
  }

  /**
   * Wrap a chart with its table view.
   *
   * Not decoration: three of the light-mode series steps fall below 3:1 against
   * white, and the palette rule is that such a palette ships visible labels or a
   * table. It is also the answer for anyone who cannot use a hover tooltip.
   */
  function withTable(node, columns, rows) {
    const wrap = h("div", "chart-wrap");
    wrap.appendChild(node);
    if (!columns || !rows || !rows.length) return wrap;

    const toggle = h("button", "chart-table-toggle", "Show data");
    toggle.type = "button";
    const table = h("table", "chart-table");
    const thead = h("thead");
    const hr = h("tr");
    columns.forEach((c) => hr.appendChild(h("th", null, c)));
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = h("tbody");
    rows.forEach((r) => {
      const tr = h("tr");
      r.forEach((cell) => tr.appendChild(h("td", null, String(cell))));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    table.hidden = true;

    toggle.addEventListener("click", () => {
      table.hidden = !table.hidden;
      toggle.textContent = table.hidden ? "Show data" : "Hide data";
    });
    wrap.appendChild(toggle);
    wrap.appendChild(table);
    return wrap;
  }

  function emptyNote(message) {
    return h("p", "chart-empty", message);
  }

  // ---- stat tile ----------------------------------------------------------

  function statTile({ label, value, hint, tone }) {
    const box = h("div", "stat-tile" + (tone ? " is-" + tone : ""));
    box.appendChild(h("div", "stat-tile-label", label));
    box.appendChild(h("div", "stat-tile-value", value));
    if (hint) box.appendChild(h("div", "stat-tile-hint", hint));
    return box;
  }

  // ---- columns ------------------------------------------------------------

  function columns({ data, labelKey, valueKey, series = 0, format = fmt, tipLabel, wide }) {
    if (!data.length) return emptyNote("Nothing recorded in this range yet.");
    // The viewBox scales to the container, and so does its text. A card that
    // spans the row needs a much wider coordinate space, or 10px labels arrive
    // on screen at 18px; a 320px card needs the narrow one for the same reason
    // in reverse.
    const W = wide ? 1120 : 520;
    const H = wide ? 250 : 210;
    const pad = { top: 14, right: 12, bottom: 30, left: 44 };
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;
    const max = Math.max(1, ...data.map((d) => d[valueKey]));
    const step = plotW / data.length;
    // A 2px surface gap between adjacent fills, so bars read as separate marks
    // rather than one striped block.
    const barW = Math.max(2, Math.min(28, step - 2));

    const svg = root(W, H);
    svg.appendChild(gridY(pad, plotW, plotH, max, format));

    data.forEach((d, i) => {
      const value = d[valueKey];
      const barH = value === 0 ? 0 : Math.max(2, (value / max) * plotH);
      const x = pad.left + i * step + (step - barW) / 2;
      const y = pad.top + plotH - barH;
      const bar = el("rect", {
        x,
        y,
        width: barW,
        height: barH,
        rx: Math.min(4, barW / 2),
        fill: SERIES(series),
        class: "chart-mark",
      });
      bindTip(bar, `<strong>${d[labelKey]}</strong><br>${format(value)} ${tipLabel || ""}`);
      svg.appendChild(bar);
    });

    // Selective, never one label per bar: first, last, and the peak.
    const peak = data.reduce((best, d, i) => (d[valueKey] > data[best][valueKey] ? i : best), 0);
    new Set([0, data.length - 1, peak]).forEach((i) => {
      const d = data[i];
      if (!d) return;
      svg.appendChild(
        el("text", {
          x: pad.left + i * step + step / 2,
          y: H - 10,
          "text-anchor": "middle",
          class: "chart-axis-label",
        }, [textNode(axisLabel(d[labelKey]))]),
      );
    });

    return withTable(
      svg,
      [labelKey, valueKey],
      data.map((d) => [d[labelKey], format(d[valueKey])]),
    );
  }

  function textNode(value) {
    return document.createTextNode(value);
  }

  // Week labels are ISO dates and only the month-day part fits under a column;
  // every other label is already short and must be left alone. Slicing
  // unconditionally turned "unscheduled" into "eduled".
  function axisLabel(value) {
    const s = String(value);
    return s.length === 10 && s[4] === "-" && s[7] === "-" ? s.slice(5) : s;
  }

  function gridY(pad, plotW, plotH, max, format) {
    const g = el("g");
    // Counts are integers, so a maximum of 2 must not be labelled 0, 0.5, 1,
    // 1.5, 2 - the half-steps are values the data cannot take.
    const ticks = max <= 4 ? Math.max(1, Math.ceil(max)) : 4;
    for (let i = 0; i <= ticks; i++) {
      const y = pad.top + plotH - (i / ticks) * plotH;
      g.appendChild(
        el("line", { x1: pad.left, y1: y, x2: pad.left + plotW, y2: y, class: "chart-gridline" }),
      );
      g.appendChild(
        el("text", { x: pad.left - 8, y: y + 4, "text-anchor": "end", class: "chart-axis-label" }, [
          textNode(format((max * i) / ticks)),
        ]),
      );
    }
    return g;
  }

  // ---- lines --------------------------------------------------------------

  function lines({ data, labelKey, series, format = fmt, wide }) {
    if (!data.length) return emptyNote("Nothing recorded in this range yet.");
    const W = wide ? 1120 : 520;
    const H = wide ? 260 : 220;
    const pad = { top: 14, right: 12, bottom: 30, left: 44 };
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;
    const max = Math.max(
      1,
      ...data.flatMap((d) => series.map((s) => d[s.key] || 0)),
    );
    const xAt = (i) => pad.left + (data.length === 1 ? plotW / 2 : (i / (data.length - 1)) * plotW);
    const yAt = (v) => pad.top + plotH - (v / max) * plotH;

    const svg = root(W, H);
    svg.appendChild(gridY(pad, plotW, plotH, max, format));

    series.forEach((s, si) => {
      const points = data.map((d, i) => `${xAt(i)},${yAt(d[s.key] || 0)}`).join(" ");
      svg.appendChild(
        el("polyline", {
          points,
          fill: "none",
          stroke: SERIES(si),
          "stroke-width": 2,
          "stroke-linejoin": "round",
          "stroke-linecap": "round",
        }),
      );
    });

    // One crosshair band per x position, spanning the full plot height, so the
    // hit target is the column rather than the 2px line.
    data.forEach((d, i) => {
      const band = el("rect", {
        x: xAt(i) - plotW / Math.max(1, data.length) / 2,
        y: pad.top,
        width: Math.max(4, plotW / Math.max(1, data.length)),
        height: plotH,
        fill: "transparent",
        class: "chart-hit",
      });
      const rows = series
        .map((s, si) => `<span class="tip-dot" style="background:${SERIES(si)}"></span>${s.label}: <strong>${format(d[s.key] || 0)}</strong>`)
        .join("<br>");
      bindTip(band, `<strong>${d[labelKey]}</strong><br>${rows}`);
      svg.appendChild(band);
    });

    [0, data.length - 1].forEach((i) => {
      const d = data[i];
      if (!d) return;
      svg.appendChild(
        el("text", {
          x: xAt(i),
          y: H - 10,
          "text-anchor": i === 0 ? "start" : "end",
          class: "chart-axis-label",
        }, [textNode(axisLabel(d[labelKey]))]),
      );
    });

    const wrap = withTable(
      svg,
      [labelKey, ...series.map((s) => s.label)],
      data.map((d) => [d[labelKey], ...series.map((s) => format(d[s.key] || 0))]),
    );
    // A legend is always present from two series up; identity is never carried
    // by colour alone.
    if (series.length > 1) wrap.insertBefore(legend(series), wrap.firstChild);
    return wrap;
  }

  // ---- stacked columns ----------------------------------------------------

  function stacked({ data, labelKey, series, format = fmt, wide }) {
    if (!data.length) return emptyNote("Nothing recorded in this range yet.");
    const W = wide ? 1120 : 520;
    const H = wide ? 250 : 210;
    const pad = { top: 14, right: 12, bottom: 30, left: 44 };
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;
    const totals = data.map((d) => series.reduce((n, s) => n + (d[s.key] || 0), 0));
    const max = Math.max(1, ...totals);
    const step = plotW / data.length;
    const barW = Math.max(2, Math.min(28, step - 2));

    const svg = root(W, H);
    svg.appendChild(gridY(pad, plotW, plotH, max, format));

    data.forEach((d, i) => {
      let cursor = 0;
      series.forEach((s, si) => {
        const value = d[s.key] || 0;
        if (!value) return;
        const segH = (value / max) * plotH;
        const x = pad.left + i * step + (step - barW) / 2;
        // 2px gap between stacked segments, same rule as between bars.
        const y = pad.top + plotH - cursor - segH;
        const rect = el("rect", {
          x,
          y: y + 1,
          width: barW,
          height: Math.max(1, segH - 2),
          rx: 2,
          fill: SERIES(si),
          class: "chart-mark",
        });
        bindTip(rect, `<strong>${d[labelKey]}</strong><br>${s.label}: <strong>${format(value)}</strong>`);
        svg.appendChild(rect);
        cursor += segH;
      });
    });

    const wrap = withTable(
      svg,
      [labelKey, ...series.map((s) => s.label)],
      data.map((d) => [d[labelKey], ...series.map((s) => format(d[s.key] || 0))]),
    );
    wrap.insertBefore(legend(series), wrap.firstChild);
    return wrap;
  }

  // ---- donut --------------------------------------------------------------

  function donut({ slices, centreLabel, centreValue }) {
    const total = slices.reduce((n, s) => n + s.value, 0);
    if (!total) return emptyNote("Nothing to show yet.");
    const size = 180;
    const r = 66;
    const stroke = 26;
    const c = size / 2;
    const svg = root(size, size);
    let angle = -Math.PI / 2;

    slices.forEach((slice, i) => {
      const portion = slice.value / total;
      // A 2px surface ring between arcs, so touching slices stay separable
      // without relying on the hue difference alone.
      const sweep = portion * Math.PI * 2;
      const end = angle + sweep;
      const large = sweep > Math.PI ? 1 : 0;
      const path = el("path", {
        d: [
          "M", c + r * Math.cos(angle), c + r * Math.sin(angle),
          "A", r, r, 0, large, 1, c + r * Math.cos(end), c + r * Math.sin(end),
        ].join(" "),
        fill: "none",
        stroke: slice.color || SERIES(i),
        "stroke-width": stroke,
        class: "chart-arc",
      });
      bindTip(
        path,
        `${slice.label}: <strong>${fmt(slice.value)}</strong> (${Math.round(portion * 100)}%)`,
      );
      svg.appendChild(path);
      angle = end;
    });

    if (centreValue !== undefined) {
      svg.appendChild(
        el("text", { x: c, y: c - 2, "text-anchor": "middle", class: "chart-centre-value" }, [
          textNode(String(centreValue)),
        ]),
      );
      svg.appendChild(
        el("text", { x: c, y: c + 16, "text-anchor": "middle", class: "chart-centre-label" }, [
          textNode(centreLabel || ""),
        ]),
      );
    }

    const wrap = withTable(
      svg,
      ["Segment", "Count", "Share"],
      slices.map((s) => [s.label, fmt(s.value), Math.round((s.value / total) * 100) + "%"]),
    );
    wrap.classList.add("chart-wrap-donut");
    wrap.insertBefore(legend(slices), wrap.firstChild);
    return wrap;
  }

  // ---- horizontal bars ----------------------------------------------------

  function hbar({ rows, format = fmt, series = 0, suffix }) {
    if (!rows.length) return emptyNote("Nothing to show yet.");
    const max = Math.max(1, ...rows.map((r) => r.value));
    const box = h("div", "hbar");
    rows.forEach((row) => {
      const line = h("div", "hbar-row");
      line.appendChild(h("span", "hbar-label", row.label));
      const track = h("span", "hbar-track");
      const fill = h("span", "hbar-fill");
      fill.style.width = Math.max(2, (row.value / max) * 100) + "%";
      fill.style.background = row.color || SERIES(series);
      track.appendChild(fill);
      line.appendChild(track);
      // Direct label on every row: this form has room for it, and it is the
      // relief the light palette owes.
      line.appendChild(h("span", "hbar-value", format(row.value) + (suffix || "")));
      if (row.hint) line.title = row.hint;
      box.appendChild(line);
    });
    return withTable(box, ["Label", "Value"], rows.map((r) => [r.label, format(r.value)]));
  }

  // ---- heatmap ------------------------------------------------------------

  function heatmap({ cells, rows, cols, rowLabel, colLabel, valueLabel, format = fmt }) {
    const values = cells.map((c) => c.value).filter((v) => v > 0);
    if (!values.length) return emptyNote("Nothing recorded in this range yet.");
    const max = Math.max(...values);
    const lookup = new Map(cells.map((c) => [c.row + ":" + c.col, c.value]));

    const box = h("div", "heatmap");
    const grid = h("div", "heatmap-grid");
    grid.style.gridTemplateColumns = `auto repeat(${cols.length}, 1fr)`;

    grid.appendChild(h("span", "heatmap-corner", ""));
    cols.forEach((c, i) => {
      const cell = h("span", "heatmap-col-label", i % 2 === 0 ? c.label : "");
      grid.appendChild(cell);
    });

    rows.forEach((r) => {
      grid.appendChild(h("span", "heatmap-row-label", r.label));
      cols.forEach((c) => {
        const value = lookup.get(r.key + ":" + c.key) || 0;
        const cell = h("span", "heatmap-cell");
        // Sequential, one hue light-to-dark. Six steps rather than a continuous
        // alpha, so the same value reads the same everywhere on the grid.
        const level = value === 0 ? 0 : Math.min(5, Math.ceil((value / max) * 5));
        cell.style.background = `var(--chart-seq-${level})`;
        if (value > 0) {
          bindTip(
            cell,
            `${rowLabel} <strong>${r.label}</strong>, ${colLabel} <strong>${c.label}</strong><br>${format(value)} ${valueLabel || ""}`,
          );
        }
        grid.appendChild(cell);
      });
    });

    box.appendChild(grid);
    const scale = h("div", "heatmap-scale");
    scale.appendChild(h("span", "heatmap-scale-label", "0"));
    for (let i = 0; i <= 5; i++) {
      const swatch = h("span", "heatmap-scale-step");
      swatch.style.background = `var(--chart-seq-${i})`;
      scale.appendChild(swatch);
    }
    scale.appendChild(h("span", "heatmap-scale-label", format(max)));
    box.appendChild(scale);

    return withTable(
      box,
      [rowLabel, colLabel, valueLabel || "Value"],
      cells.filter((c) => c.value > 0).map((c) => [c.rowLabel, c.colLabel, format(c.value)]),
    );
  }

  // ---- sparkline ----------------------------------------------------------

  function sparkline(values, { width = 90, height = 22 } = {}) {
    const svg = root(width, height);
    svg.classList.add("sparkline");
    if (!values.length) return svg;
    const max = Math.max(1, ...values);
    const step = values.length === 1 ? width : width / (values.length - 1);
    const points = values
      .map((v, i) => `${i * step},${height - (v / max) * (height - 3) - 1.5}`)
      .join(" ");
    svg.appendChild(
      el("polyline", {
        points,
        fill: "none",
        stroke: SERIES(0),
        "stroke-width": 1.5,
        "stroke-linejoin": "round",
        "stroke-linecap": "round",
      }),
    );
    return svg;
  }

  return {
    statTile,
    columns,
    lines,
    stacked,
    donut,
    hbar,
    heatmap,
    sparkline,
    legend,
    withTable,
    emptyNote,
    fmt,
    fmtMinutes,
    fmtDate,
    fmtAgo,
    SERIES,
  };
})();
