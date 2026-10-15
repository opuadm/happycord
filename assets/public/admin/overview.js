"use strict";

{
  const SVG_NS = "http://www.w3.org/2000/svg";
  const RANGES = [
    ["24h", "24 hours", "the last 24 hours"],
    ["7d", "7 days", "the last 7 days"],
    ["30d", "30 days", "the last 30 days"],
    ["90d", "90 days", "the last 90 days"],
  ];
  const RANGE_TEXT = Object.fromEntries(RANGES.map(([key, , text]) => [key, text]));
  const PREVIOUS_TEXT = {
    "24h": "the 24 hours before",
    "7d": "the 7 days before",
    "30d": "the 30 days before",
    "90d": "the 90 days before",
  };
  const SERIES_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];
  const CHARTS = [
    {
      id: "accounts",
      title: "New accounts",
      hint: "Accounts registered on this instance, without bots",
      metrics: ["accounts"],
      noun: ["new account", "new accounts"],
    },
    {
      id: "messages",
      title: "Messages sent",
      hint: "Messages from local and federated accounts",
      metrics: ["messages"],
      noun: ["message", "messages"],
    },
    {
      id: "active",
      title: "Active people",
      hint: "Different accounts that sent at least one message",
      metrics: ["active_users"],
      noun: ["active person", "active people"],
      distinct: true,
    },
    {
      id: "servers",
      title: "New servers",
      hint: "Servers created on this instance",
      metrics: ["servers"],
      noun: ["new server", "new servers"],
    },
    {
      id: "reports",
      title: "Reports opened and closed",
      hint: "Closed counts resolved and dismissed reports",
      metrics: ["reports_opened", "reports_closed"],
      labels: { reports_opened: "Opened", reports_closed: "Closed" },
      noun: ["report", "reports"],
      access: "reports",
    },
    {
      id: "automod",
      title: "Automod actions",
      hint: "Blocks, deletions, holds, logs and other actions automod took",
      metrics: ["automod_actions"],
      noun: ["action", "actions"],
      access: "reports",
    },
    {
      id: "federation",
      title: "Federation",
      hint: "New ids this instance learned from each instance, a measure of incoming traffic",
      metrics: ["federation"],
      noun: ["new id", "new ids"],
      access: "operator",
    },
    {
      id: "storage",
      title: "Attachment uploads",
      hint: "Bytes of attachments added to messages",
      metrics: ["attachment_bytes"],
      unit: "bytes",
      access: "operator",
    },
  ];

  const storageKey = (id) => `admin.overview.range.${id}`;
  const readRange = (id, fallback) => {
    try {
      const value = localStorage.getItem(storageKey(id));
      return RANGE_TEXT[value] ? value : fallback;
    } catch {
      return fallback;
    }
  };
  const writeRange = (id, value) => {
    try {
      localStorage.setItem(storageKey(id), value);
    } catch {}
  };

  const utcOffset = () => {
    const minutes = -new Date().getTimezoneOffset();
    return Math.max(-720, Math.min(840, Math.round(minutes / 15) * 15));
  };

  const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
  const fmtCount = (n) => (Math.abs(n) >= 10000 ? compact.format(n) : fmtNumber(n));
  const fmtSize = (n) => {
    if (n == null) return "Unknown";
    const units = ["bytes", "KB", "MB", "GB", "TB", "PB"];
    let value = Number(n);
    let unit = 0;
    while (Math.abs(value) >= 1000 && unit < units.length - 1) {
      value /= 1000;
      unit++;
    }
    if (!unit) return `${fmtNumber(value)} ${value === 1 ? "byte" : "bytes"}`;
    return `${value.toLocaleString(undefined, { maximumFractionDigits: value < 10 ? 1 : 0 })} ${units[unit]}`;
  };
  const fmtValue = (n, unit) => (unit === "bytes" ? fmtSize(n) : fmtNumber(n));
  const fmtTick = (n, unit) => (unit === "bytes" && n ? fmtSize(n) : fmtCount(n));
  const plural = (n, [one, many]) => `${fmtNumber(n)} ${n === 1 ? one : many}`;

  const bucketLabel = (iso, bucket, long = false) => {
    const date = new Date(iso);
    if (bucket === "hour")
      return long
        ? date.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })
        : date.toLocaleTimeString(undefined, { hour: "numeric" });
    return date.toLocaleDateString(undefined, long ? { weekday: "short", month: "short", day: "numeric" } : { month: "short", day: "numeric" });
  };

  const niceStep = (raw) => {
    const power = 10 ** Math.floor(Math.log10(raw));
    const fraction = raw / power;
    return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10) * power;
  };
  const yTicks = (max, unit) => {
    if (max <= 0) return { top: unit === "bytes" ? 1000 : 4, ticks: unit === "bytes" ? [0, 500, 1000] : [0, 1, 2, 3, 4] };
    const step = niceStep(max / 4);
    const integerStep = unit === "bytes" ? step : Math.max(1, Math.ceil(step));
    const top = Math.ceil(max / integerStep) * integerStep;
    const ticks = [];
    for (let value = 0; value <= top + integerStep / 2; value += integerStep) ticks.push(value);
    return { top, ticks };
  };

  const xLabelEvery = (count, bucket, plotWidth) => {
    const room = Math.max(1, Math.floor(plotWidth / 64));
    const steps = bucket === "hour" ? [1, 2, 3, 4, 6, 12, 24] : [1, 2, 7, 14, 15, 30, 45, 90];
    return steps.find((step) => Math.ceil(count / step) <= room) ?? count;
  };

  const svg = (name, attributes = {}) => {
    const element = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
    return element;
  };

  const roundedBar = (x, y, width, height) => {
    const radius = Math.min(4, width / 2, height);
    if (radius < 1) return `M${x},${y + height}V${y}H${x + width}V${y + height}Z`;
    return `M${x},${y + height}V${y + radius}Q${x},${y} ${x + radius},${y}H${x + width - radius}Q${x + width},${y} ${x + width},${y + radius}V${y + height}Z`;
  };

  const seriesLabel = (chart, series) => {
    if (chart.labels?.[series.key]) return chart.labels[series.key];
    if (series.key === "other") return `${fmtNumber(series.instances ?? 0)} other instances`;
    return series.key;
  };

  const summarize = (chart, data) => {
    const range = RANGE_TEXT[data.range];
    const per = data.bucket === "hour" ? "hour" : "day";
    const parts = data.series.map((series) => {
      let peak = 0;
      series.points.forEach((value, index) => {
        if (value > series.points[peak]) peak = index;
      });
      const total = chart.unit === "bytes" ? fmtSize(series.total) : chart.noun ? plural(series.total, chart.noun) : fmtNumber(series.total);
      const name = data.series.length > 1 ? `${seriesLabel(chart, series)}: ` : "";
      const peakText = series.points[peak] ? `, highest ${fmtValue(series.points[peak], chart.unit)} on ${bucketLabel(data.buckets[peak], data.bucket, true)}` : "";
      return `${name}${total}${peakText}`;
    });
    return `${chart.title} per ${per} over ${range}. ${parts.join(". ") || "No data"}.`;
  };

  function drawChart(host, chart, data) {
    const width = Math.max(240, Math.floor(host.clientWidth));
    const narrow = width < 480;
    const height = narrow ? 180 : 220;
    const unit = chart.unit ?? "count";
    const max = Math.max(0, ...data.series.flatMap((series) => series.points));
    const { top, ticks } = yTicks(max, unit);
    const tickLabels = ticks.map((tick) => fmtTick(tick, unit));
    const left = Math.max(...tickLabels.map((label) => label.length)) * 7 + 12;
    const margin = { top: 10, right: 10, bottom: 26, left };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const count = data.buckets.length;
    const band = plotWidth / count;
    const yAt = (value) => margin.top + plotHeight - (value / top) * plotHeight;
    const xAt = (index) => margin.left + band * index + band / 2;

    const root = svg("svg", { width, height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": summarize(chart, data), class: "chart-svg" });
    const grid = svg("g", { class: "chart-axes", "aria-hidden": "true" });
    ticks.forEach((tick, index) => {
      const y = Math.round(yAt(tick)) + 0.5;
      grid.append(svg("line", { x1: margin.left, x2: width - margin.right, y1: y, y2: y, class: tick === 0 ? "chart-baseline" : "" }));
      const label = svg("text", { x: margin.left - 8, y, dy: "0.32em", "text-anchor": "end", class: "chart-tick" });
      label.textContent = tickLabels[index];
      grid.append(label);
    });
    const every = xLabelEvery(count, data.bucket, plotWidth);
    for (let index = count - 1; index >= 0; index -= every) {
      const label = svg("text", { x: xAt(index), y: height - 8, "text-anchor": index === count - 1 && band < 40 ? "end" : "middle", class: "chart-tick" });
      if (index === count - 1 && band < 40) label.setAttribute("x", width - margin.right);
      label.textContent = bucketLabel(data.buckets[index], data.bucket);
      grid.append(label);
    }
    root.append(grid);

    const highlight = svg("rect", { class: "chart-highlight", y: margin.top, height: plotHeight, width: Math.max(band, 2), x: 0, visibility: "hidden", "aria-hidden": "true" });
    root.append(highlight);

    const marks = svg("g", { "aria-hidden": "true" });
    const asBars = data.series.length === 1;
    if (asBars) {
      const [series] = data.series;
      const barWidth = Math.max(1, Math.min(24, band - 2));
      series.points.forEach((value, index) => {
        if (!value) return;
        const y = yAt(value);
        const barHeight = Math.max(1, margin.top + plotHeight - y);
        marks.append(svg("path", { d: roundedBar(xAt(index) - barWidth / 2, margin.top + plotHeight - barHeight, barWidth, barHeight), fill: SERIES_COLORS[0] }));
      });
    } else {
      data.series.forEach((series, seriesIndex) => {
        const color = series.key === "other" ? "var(--chart-other)" : SERIES_COLORS[seriesIndex % SERIES_COLORS.length];
        const path = series.points.map((value, index) => `${index ? "L" : "M"}${xAt(index).toFixed(1)},${yAt(value).toFixed(1)}`).join("");
        marks.append(svg("path", { d: path, fill: "none", stroke: color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
        marks.append(svg("circle", { cx: xAt(count - 1), cy: yAt(series.points.at(-1)), r: 4, fill: color, class: "chart-dot" }));
      });
    }
    root.append(marks);

    const cursor = svg("g", { "aria-hidden": "true", visibility: "hidden" });
    const cursorLine = svg("line", { y1: margin.top, y2: margin.top + plotHeight, class: "chart-cursor" });
    cursor.append(cursorLine);
    const cursorDots = asBars
      ? []
      : data.series.map((series, seriesIndex) => {
          const dot = svg("circle", { r: 4, fill: series.key === "other" ? "var(--chart-other)" : SERIES_COLORS[seriesIndex % SERIES_COLORS.length], class: "chart-dot" });
          cursor.append(dot);
          return dot;
        });
    if (!asBars) root.append(cursor);

    const tooltip = host.querySelector(".chart-tooltip");
    let active = -1;
    const show = (index) => {
      active = Math.max(0, Math.min(count - 1, index));
      const x = xAt(active);
      highlight.setAttribute("x", margin.left + band * active);
      highlight.setAttribute("visibility", asBars ? "visible" : "hidden");
      if (!asBars) {
        cursor.setAttribute("visibility", "visible");
        cursorLine.setAttribute("x1", x);
        cursorLine.setAttribute("x2", x);
        cursorDots.forEach((dot, seriesIndex) => {
          dot.setAttribute("cx", x);
          dot.setAttribute("cy", yAt(data.series[seriesIndex].points[active]));
        });
      }
      mount(
        tooltip,
        html`<strong>${bucketLabel(data.buckets[active], data.bucket, true)}</strong>
          ${data.series.map(
            (series, seriesIndex) =>
              html`<span class="chart-tooltip-row"
                >${data.series.length > 1 ? html`<span class="chart-key" style="background:${series.key === "other" ? "var(--chart-other)" : SERIES_COLORS[seriesIndex % SERIES_COLORS.length]}"></span>${seriesLabel(chart, series)}` : html`<span>${chart.title}</span>`}<span class="chart-tooltip-value">${fmtValue(series.points[active], unit)}</span></span
              >`,
          )}`,
      );
      tooltip.hidden = false;
      const tipWidth = tooltip.offsetWidth;
      const gap = band / 2 + 8;
      const right = x + gap;
      const left = x - gap - tipWidth;
      tooltip.style.left = `${right + tipWidth <= width || left < 0 ? Math.max(0, Math.min(width - tipWidth, right)) : left}px`;
      tooltip.style.top = `${margin.top}px`;
    };
    const hide = () => {
      active = -1;
      tooltip.hidden = true;
      highlight.setAttribute("visibility", "hidden");
      cursor.setAttribute("visibility", "hidden");
    };

    const plot = host.querySelector(".chart-plot");
    plot.replaceChildren(root);
    plot.onpointermove = (event) => {
      const box = root.getBoundingClientRect();
      const x = event.clientX - box.left - margin.left;
      if (x < -band / 2 || x > plotWidth + band / 2) return hide();
      show(Math.floor(x / band));
    };
    plot.onpointerleave = (event) => {
      if (event.pointerType === "mouse") hide();
    };
    plot.onfocus = () => show(active < 0 ? count - 1 : active);
    plot.onblur = hide;
    plot.onkeydown = (event) => {
      const moves = { ArrowLeft: active - 1, ArrowRight: active + 1, Home: 0, End: count - 1 };
      if (!(event.key in moves)) {
        if (event.key === "Escape") hide();
        return;
      }
      event.preventDefault();
      show(moves[event.key]);
    };
  }

  const chartTable = (chart, data) => html`
    <table class="chart-table">
      <thead>
        <tr>
          <th scope="col">${data.bucket === "hour" ? "Hour" : "Day"}</th>
          ${data.series.map((series) => html`<th scope="col">${data.series.length > 1 ? seriesLabel(chart, series) : chart.title}</th>`)}
        </tr>
      </thead>
      <tbody>
        ${data.buckets.map(
          (bucket, index) => html`<tr>
            <th scope="row">${bucketLabel(bucket, data.bucket, true)}</th>
            ${data.series.map((series) => html`<td>${fmtValue(series.points[index], chart.unit)}</td>`)}
          </tr>`,
        )}
      </tbody>
    </table>
  `;

  const deltaInfo = (current, previous, upIsGood = true) => {
    if (!current && !previous) return { direction: "flat", text: "No change" };
    if (!previous) return { direction: "up", good: upIsGood, text: "Up from 0" };
    const change = Math.round(((current - previous) / previous) * 100);
    if (!change) return { direction: "flat", text: "No change" };
    return { direction: change > 0 ? "up" : "down", good: change > 0 === upIsGood, text: `${change > 0 ? "Up" : "Down"} ${fmtNumber(Math.abs(change))}%` };
  };
  const deltaView = (info, against) =>
    html`<span class="delta ${info.direction === "flat" ? "" : info.good ? "good" : "bad"}"
      ><span class="delta-icon" aria-hidden="true">${info.direction === "up" ? "↑" : info.direction === "down" ? "↓" : "→"}</span
      >${info.text}${against ? html` <span class="muted">vs ${against}</span>` : ""}</span
    >`;

  function headline(chart, data) {
    if (data.series.length > 1 && chart.id !== "reports") {
      const total = data.series.reduce((sum, series) => sum + series.total, 0);
      return html`<p class="chart-headline"><strong>${chart.noun ? plural(total, chart.noun) : fmtNumber(total)}</strong> <span class="muted">in ${RANGE_TEXT[data.range]}</span></p>`;
    }
    const [series] = data.series;
    if (!series) return html`<p class="chart-headline muted">Nothing in ${RANGE_TEXT[data.range]}.</p>`;
    const value = chart.unit === "bytes" ? fmtSize(series.total) : chart.noun ? plural(series.total, chart.noun) : fmtNumber(series.total);
    const against = PREVIOUS_TEXT[data.range];
    return html`<p class="chart-headline">
      <strong>${chart.id === "reports" ? `${plural(series.total, ["report", "reports"])} opened` : value}</strong>
      <span class="muted">in ${RANGE_TEXT[data.range]}</span>
      ${series.previous_total == null ? "" : deltaView(deltaInfo(series.total, series.previous_total, !["reports", "automod"].includes(chart.id)), against)}
    </p>
    ${chart.id === "reports" && data.series[1] ? html`<p class="chart-sub muted">${plural(data.series[1].total, ["report", "reports"])} closed</p>` : ""}
    ${chart.id === "storage" && data.stored_bytes > 0 ? html`<p class="chart-sub muted">All stored files take ${fmtSize(data.stored_bytes)}.</p>` : ""}`;
  }

  async function loadChart(chart, range, fetchSeries) {
    const results = await Promise.all(chart.metrics.map((metric) => fetchSeries(metric, range)));
    const [first] = results;
    return {
      ...first,
      series: results.flatMap((result) => result.series),
    };
  }

  function mountChart(card, chart, fetchSeries) {
    let range = readRange(chart.id, "7d");
    let data = null;
    let request = 0;
    const host = $(".chart-host", card);
    const render = async () => {
      const ticket = ++request;
      card.setAttribute("aria-busy", "true");
      for (const button of $$("[data-range]", card)) button.setAttribute("aria-pressed", String(button.dataset.range === range));
      try {
        const next = await loadChart(chart, range, fetchSeries);
        if (ticket !== request || !card.isConnected) return;
        data = next;
        mount($(".chart-summary", card), headline(chart, data));
        mount($(".chart-legend", card), data.series.length > 1 ? data.series.map((series, index) => html`<li><span class="chart-key" style="background:${series.key === "other" ? "var(--chart-other)" : SERIES_COLORS[index % SERIES_COLORS.length]}"></span>${seriesLabel(chart, series)} <span class="muted">${fmtValue(series.total, chart.unit)}</span></li>`) : "");
        $(".chart-legend", card).hidden = data.series.length < 2;
        const empty = data.series.every((series) => series.points.every((value) => !value));
        $(".chart-empty", card).hidden = !empty;
        mount($(".chart-numbers", card), chartTable(chart, data));
        drawChart(host, chart, data);
      } catch (error) {
        if (ticket !== request || error.status === 499) return;
        mount(
          $(".chart-summary", card),
          html`<p class="chart-headline muted">Couldn't load this chart. ${error.message}</p>
            <button class="btn small" type="button" data-retry>Try again</button>`,
        );
        $("[data-retry]", card).onclick = render;
      } finally {
        if (ticket === request) card.removeAttribute("aria-busy");
      }
    };
    card.addEventListener("click", (event) => {
      const button = event.target.closest("[data-range]");
      if (!button || button.dataset.range === range) return;
      range = button.dataset.range;
      writeRange(chart.id, range);
      render();
    });
    let frame = 0;
    let lastWidth = host.clientWidth;
    const observer = new ResizeObserver(() => {
      if (!card.isConnected) return observer.disconnect();
      if (host.clientWidth === lastWidth) return;
      lastWidth = host.clientWidth;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => data && drawChart(host, chart, data));
    });
    observer.observe(host);
    return render();
  }

  const chartCard = (chart) => html`
    <section class="card chart-card" aria-labelledby="chart-${chart.id}-title">
      <div class="chart-head">
        <div>
          <h3 class="chart-title" id="chart-${chart.id}-title">${chart.title}</h3>
          <p class="hint">${chart.hint}</p>
        </div>
        <div class="segmented" role="group" aria-label="Range for ${chart.title.toLowerCase()}">
          ${RANGES.map(([key, label]) => html`<button type="button" data-range="${key}" aria-pressed="false">${label}</button>`)}
        </div>
      </div>
      <div class="chart-summary"><p class="chart-headline muted">Loading…</p></div>
      <ul class="chart-legend" hidden></ul>
      <div class="chart-host">
        <div class="chart-plot" tabindex="0" role="group" aria-label="${chart.title}. Use the left and right arrow keys to read each value."></div>
        <div class="chart-tooltip" role="status" hidden></div>
        <p class="chart-empty muted" hidden>Nothing in this range yet.</p>
      </div>
      <details class="chart-details">
        <summary>Show the numbers</summary>
        <div class="table-wrap chart-numbers"></div>
      </details>
    </section>
  `;

  function sparkline(points, upIsGood) {
    const width = 120;
    const height = 32;
    const max = Math.max(1, ...points);
    const step = width / Math.max(1, points.length - 1);
    const coords = points.map((value, index) => [index * step, height - 3 - (value / max) * (height - 6)]);
    const line = coords.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
    const area = `${line}L${width},${height}L0,${height}Z`;
    return raw(
      `<svg class="sparkline ${upIsGood ? "" : "inverse"}" viewBox="0 -2 ${width} ${height + 4}" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path class="sparkline-area" d="${area}"/><path class="sparkline-line" d="${line}" vector-effect="non-scaling-stroke"/></svg>`,
    );
  }

  const statCard = ({ label, value, href, sub, delta, against, points, upIsGood = true }) => html`
    <${raw(href ? "a" : "div")} class="card stat stat-trend" ${href ? raw(`href="${escapeHtml(href)}"`) : ""}>
      <span class="stat-label">${label}</span>
      <span class="value">${value}</span>
      ${points ? sparkline(points, upIsGood) : ""}
      <span class="stat-sub">${sub}</span>
      ${delta ? deltaView(delta, against) : ""}
    </${raw(href ? "a" : "div")}>
  `;

  async function renderTrendCards(container, o, fetchSeries) {
    const access = o.access;
    const pick = (promise) => promise.then((result) => result.series[0]).catch(() => null);
    const [accounts, servers, messages, active, reports] = await Promise.all([
      pick(fetchSeries("accounts", "7d")),
      pick(fetchSeries("servers", "7d")),
      pick(fetchSeries("messages", "24h")),
      pick(fetchSeries("active_users", "24h")),
      access.reports ? pick(fetchSeries("reports_opened", "7d")) : null,
    ]);
    if (!container.isConnected) return;
    const cards = [
      {
        label: "Accounts",
        value: fmtCount(o.counts.users),
        href: access.users ? "#/users" : null,
        sub: accounts ? `${plural(accounts.total, ["new account", "new accounts"])} in 7 days` : "New accounts unavailable",
        delta: accounts && deltaInfo(accounts.total, accounts.previous_total),
        against: "the week before",
        points: accounts?.points,
      },
      {
        label: "Servers",
        value: fmtCount(o.counts.guilds),
        href: access.guilds ? "#/guilds" : null,
        sub: servers ? `${plural(servers.total, ["new server", "new servers"])} in 7 days` : "New servers unavailable",
        delta: servers && deltaInfo(servers.total, servers.previous_total),
        against: "the week before",
        points: servers?.points,
      },
      {
        label: "Messages in 24 hours",
        value: messages ? fmtCount(messages.total) : "Unavailable",
        sub: `${fmtCount(o.counts.messages)} in total`,
        delta: messages && deltaInfo(messages.total, messages.previous_total),
        against: "the 24 hours before",
        points: messages?.points,
      },
      {
        label: "Online now",
        value: fmtCount(o.counts.online ?? 0),
        sub: active ? `${plural(active.total, ["person", "people"])} sent messages in 24 hours` : "Message senders unavailable",
        delta: active && deltaInfo(active.total, active.previous_total),
        against: "the 24 hours before",
        points: active?.points,
      },
      access.reports && {
        label: "Open reports",
        value: fmtCount(o.counts.open_reports),
        href: "#/reports",
        sub: reports ? `${plural(reports.total, ["report", "reports"])} opened in 7 days` : "New reports unavailable",
        delta: reports && deltaInfo(reports.total, reports.previous_total, false),
        against: "the week before",
        points: reports?.points,
        upIsGood: false,
      },
    ].filter(Boolean);
    mount(container, cards.map(statCard));
  }

  async function renderOverview(view) {
    const o = await api("/admin");
    state.overview = o;
    syncNavCounts();
    const status = await api("/status/summary.json", { auth: false }).catch(() => null);
    const offset = utcOffset();
    const requests = new Map();
    const fetchSeries = (metric, range) => {
      const key = `${metric}:${range}`;
      if (!requests.has(key)) {
        const request = api(`/admin/stats/timeseries?metric=${encodeURIComponent(metric)}&range=${encodeURIComponent(range)}&utc_offset=${offset}`);
        request.catch(() => requests.delete(key));
        requests.set(key, request);
        setTimeout(() => requests.delete(key), 60000);
      }
      return requests.get(key);
    };
    const charts = CHARTS.filter((chart) => !chart.access || o.access[chart.access]);
    const total = (label, value, href) => html`
      <${raw(href ? "a" : "div")} class="card stat stat-small" ${href ? raw(`href="${escapeHtml(href)}"`) : ""}>
        <span class="stat-label">${label}</span>
        <span class="value">${value}</span>
      </${raw(href ? "a" : "div")}>
    `;

    mount(
      view,
      html`
        <div class="page-head">
          <div>
            <h1>${o.instance.name}</h1>
            <p class="muted">${o.instance.description || "No description set."}</p>
          </div>
          ${o.access.settings ? html`<a class="btn" href="#/settings">Edit site settings</a>` : ""}
        </div>
        <div class="stack overview">
          <div class="stats stats-trend" id="trend-cards" aria-busy="true">
            <div class="card stat stat-trend"><span class="stat-label">Loading trends…</span></div>
          </div>
          <div class="stats stats-small">
            ${o.counts.remote_users ? total("Users from other instances", fmtCount(o.counts.remote_users), o.access.users ? "#/users/remote" : null) : ""}
            ${o.counts.remote_guilds ? total("Servers on other instances", fmtCount(o.counts.remote_guilds), o.access.guilds ? "#/guilds/remote" : null) : ""}
            ${total("Memberships", fmtCount(o.counts.members))}
            ${total("Disabled accounts", fmtCount(o.counts.disabled_users), o.access.users ? "#/users" : null)}
            ${total("Open incidents", fmtCount(o.counts.open_incidents), o.access.status ? "#/status" : null)}
          </div>
          <p class="muted">Counts sampled ${fmtDate(o.counts_sampled_at)}. They refresh every ${o.counts_refresh_seconds ?? 30} seconds, and charts every 60 seconds.</p>
          <section class="activity" aria-labelledby="activity-title">
            <h2 id="activity-title">Activity</h2>
            <div class="chart-grid">${charts.map(chartCard)}</div>
          </section>
          <div class="card">
            <h3>Instance</h3>
            <div class="list">
              <div class="list-item">
                <span class="grow muted">Public status</span
                >${status ? html`<span class="badge ${status.status.indicator === "none" ? "ok" : status.status.indicator === "maintenance" ? "info" : "warn"}"><span class="dot"></span>${status.status.description}</span>` : "Unavailable"}
              </div>
              <div class="list-item"><span class="grow muted">Uptime</span><span>${fmtDuration(o.uptime)}</span></div>
              <div class="list-item"><span class="grow muted">Revision</span><code>${o.revision?.rev?.slice(0, 10) ?? "unknown"}</code></div>
              <div class="list-item"><span class="grow muted">Instance ID</span><code>${o.instance.id}</code></div>
              <div class="list-item">
                <span class="grow muted">Your access</span
                ><span class="badges"
                  >${Object.entries(o.access)
                    .filter(([key, value]) => value && key !== "operator")
                    .map(([key]) => html`<span class="badge accent">${ACCESS_LABELS[key] ?? key}</span>`)}</span
                >
              </div>
              ${
                o.access.operator || o.staff_roles?.length
                  ? html`<div class="list-item">
                      <span class="grow muted">Your staff roles</span
                      ><span class="badges">${o.access.operator ? html`<span class="badge accent">Operator</span>` : ""}${(o.staff_roles ?? []).map(staffRoleBadge)}</span>
                    </div>`
                  : ""
              }
            </div>
          </div>
        </div>
      `,
    );

    const trend = $("#trend-cards", view);
    const cards = $$(".chart-card", view);
    await Promise.all([
      renderTrendCards(trend, o, fetchSeries).finally(() => trend.removeAttribute("aria-busy")),
      ...charts.map((chart, index) => mountChart(cards[index], chart, fetchSeries)),
    ]);
  }

  TABS.overview = renderOverview;
}
