import { DAY, HOUR } from "../stats.js";
import { html, raw } from "./html.js";

const numberFormat = new Intl.NumberFormat("en-US");
const dayFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const WIDTH = 1000;
const HEIGHT = 100;

export function formatNumber(value) {
    return value === null || value === undefined ? "no data" : numberFormat.format(value);
}

export function ago(ms) {
    if (ms === null || ms === undefined) return "never";
    const minutes = Math.floor(ms / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
    return `${Math.floor(hours / 24)} days ago`;
}

export function niceMax(max) {
    if (!(max > 0)) return 2;
    const exponent = 10 ** Math.floor(Math.log10(max));
    return [2, 4, 6, 8, 10].map((step) => step * exponent).find((candidate) => candidate >= max);
}

function present(values) {
    return values.filter((value) => value !== null && value !== undefined);
}

function linePath(values, max, min = 0) {
    const n = values.length;
    const x = (index) => (n === 1 ? WIDTH / 2 : (index / (n - 1)) * WIDTH);
    const y = (value) => HEIGHT - ((value - min) / (max - min)) * HEIGHT;
    let path = "";
    let open = false;
    values.forEach((value, index) => {
        if (value === null || value === undefined) {
            open = false;
            return;
        }
        const next = values[index + 1];
        const isolated = !open && (next === null || next === undefined);
        path += `${open ? "L" : "M"}${x(index).toFixed(1)} ${y(value).toFixed(2)}${isolated ? "h0.01" : ""}`;
        open = true;
    });
    return path;
}

function areaPath(values, max) {
    const n = values.length;
    const x = (index) => (n === 1 ? WIDTH / 2 : (index / (n - 1)) * WIDTH);
    const segments = [];
    let current = [];
    values.forEach((value, index) => {
        if (value === null || value === undefined) {
            if (current.length) segments.push(current);
            current = [];
            return;
        }
        current.push([x(index), HEIGHT - (value / max) * HEIGHT]);
    });
    if (current.length) segments.push(current);
    return segments
        .filter((segment) => segment.length > 1)
        .map(
            (segment) =>
                `M${segment[0][0].toFixed(1)} ${HEIGHT}${segment.map(([px, py]) => `L${px.toFixed(1)} ${py.toFixed(2)}`).join("")}L${segment.at(-1)[0].toFixed(1)} ${HEIGHT}Z`,
        )
        .join("");
}

function describe(series, days) {
    const parts = series.map((entry) => {
        const values = present(entry.values);
        if (!values.length) return `${entry.name}: no data`;
        return values.length === 1 || values[0] === values.at(-1)
            ? `${entry.name}: ${formatNumber(values.at(-1))}`
            : `${entry.name}: from ${formatNumber(values[0])} to ${formatNumber(values.at(-1))}`;
    });
    return `Last ${days} days. ${parts.join(". ")}.`;
}

function dailyRows(times, series) {
    const rows = new Map();
    times.forEach((time, index) => {
        const day = Math.floor(time / DAY) * DAY;
        const row = rows.get(day) ?? series.map(() => null);
        series.forEach((entry, position) => {
            if (entry.values[index] !== null && entry.values[index] !== undefined) row[position] = entry.values[index];
        });
        rows.set(day, row);
    });
    return [...rows.entries()].reverse();
}

function numbersTable(times, series) {
    return html`<details class="numbers"><summary>Show the numbers</summary><div class="table-wrap"><table><thead><tr><th scope="col">Day, UTC</th>${series.map(
        (entry) => html`<th scope="col" class="num">${entry.name}</th>`,
    )}</tr></thead><tbody>${dailyRows(times, series).map(
        ([day, row]) => html`<tr><th scope="row">${new Date(day).toISOString().slice(0, 10)}</th>${row.map((value) => html`<td class="num">${formatNumber(value)}</td>`)}</tr>`,
    )}</tbody></table></div></details>`;
}

export function lineChart({ title, times, series, days, empty }) {
    const all = series.flatMap((entry) => present(entry.values));
    const latest = series.map((entry) => present(entry.values).at(-1) ?? null);
    const legend =
        series.length > 1
            ? html`<ul class="legend">${series.map(
                  (entry, index) =>
                      html`<li class="tone-${entry.tone}"><span class="swatch" aria-hidden="true"></span>${entry.name}<strong>${formatNumber(latest[index])}</strong></li>`,
              )}</ul>`
            : "";
    const headline = series.length === 1 ? html`<strong class="chart-now">${formatNumber(latest[0])}</strong>` : "";
    if (!all.length) {
        return html`<figure class="card chart"><figcaption><h3>${title}</h3></figcaption><p class="chart-empty">${empty}</p></figure>`;
    }
    const max = niceMax(Math.max(...all));
    const step = times.length > 1 ? times[1] - times[0] : HOUR;
    const data = { t: times, step, max, s: series.map((entry) => ({ n: entry.name, v: entry.values, c: entry.tone })) };
    const mid = new Date(times[Math.floor((times.length - 1) / 2)]);
    return html`<figure class="card chart">
<figcaption><h3>${title}</h3>${headline}</figcaption>
${legend}
<div class="plot" tabindex="0" role="group" aria-label="${title}, use the arrow keys to read each point" data-chart="${JSON.stringify(data)}">
<span class="y-label" style="top: 0%">${formatNumber(max)}</span><span class="y-label" style="top: 50%">${formatNumber(max / 2)}</span><span class="y-label" style="top: 100%">0</span>
<svg viewBox="0 0 ${WIDTH} ${HEIGHT}" preserveAspectRatio="none" role="img" aria-label="${title}. ${describe(series, days)}">
<line class="grid" x1="0" x2="${WIDTH}" y1="0" y2="0"/><line class="grid" x1="0" x2="${WIDTH}" y1="${HEIGHT / 2}" y2="${HEIGHT / 2}"/><line class="grid base" x1="0" x2="${WIDTH}" y1="${HEIGHT}" y2="${HEIGHT}"/>
${series.length === 1 ? html`<path class="area tone-${series[0].tone}" d="${areaPath(series[0].values, max)}"/>` : ""}
${series.map((entry) => html`<path class="line tone-${entry.tone}" d="${linePath(entry.values, max)}"/>`)}
</svg>
<span class="guide" hidden></span><div class="tip" hidden></div>
</div>
<div class="x-labels" aria-hidden="true"><span>${dayFormat.format(new Date(times[0]))}</span><span>${dayFormat.format(mid)}</span><span>${dayFormat.format(new Date(times.at(-1)))}</span></div>
${numbersTable(times, series)}
</figure>`;
}

export function sparkline(values, label) {
    const points = present(values);
    if (points.length < 2) return html`<span class="spark spark-empty" aria-hidden="true"></span>`;
    const low = Math.min(...points);
    const high = Math.max(...points);
    const padding = low === high ? 1 : (high - low) * 0.15;
    return html`<svg class="spark tone-1" viewBox="0 0 ${WIDTH} ${HEIGHT}" preserveAspectRatio="none" role="img" aria-label="${label}"><path class="line" d="${linePath(values, high + padding, low - padding)}"/></svg>`;
}

export function trend(values, days) {
    const points = present(values);
    if (points.length < 2) return "";
    const change = points.at(-1) - points[0];
    if (change === 0) return html`<span class="stat-trend">No change in ${days} days</span>`;
    return html`<span class="stat-trend">${change > 0 ? "Up" : "Down"} ${formatNumber(Math.abs(change))} in ${days} days</span>`;
}

export function statCard({ label, value, values, days, href }) {
    const shown = href ? html`<a href="${href}">${formatNumber(value)}</a>` : formatNumber(value);
    return html`<div class="card stat"><span class="stat-label">${label}</span><strong>${shown}</strong>${trend(values, days)}${sparkline(values, `${label} over the last ${days} days. ${describe([{ name: label, values }], days)}`)}</div>`;
}

export function healthBar(age) {
    const scale = 96 * HOUR;
    const width = age === null ? 100 : Math.max(1.5, Math.min(100, (age / scale) * 100));
    return raw(
        `<span class="health-bar" aria-hidden="true"><span class="health-fill" style="width: ${width.toFixed(1)}%"></span><span class="health-mark" style="left: 25%"></span></span>`,
    );
}

function chartBehavior() {
    const number = new Intl.NumberFormat("en-US");
    const label = (time, step) => {
        const date = new Date(time);
        const day = date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
        return step >= 86400000 ? day : `${day}, ${date.toISOString().slice(11, 16)} UTC`;
    };
    for (const plot of document.querySelectorAll(".plot[data-chart]")) {
        const data = JSON.parse(plot.dataset.chart);
        const svg = plot.querySelector("svg");
        const guide = plot.querySelector(".guide");
        const tip = plot.querySelector(".tip");
        const count = data.t.length;
        const dots = data.s.map((series) => {
            const dot = document.createElement("span");
            dot.className = `dot tone-${series.c}`;
            dot.hidden = true;
            plot.append(dot);
            return dot;
        });
        let current = null;
        const hide = () => {
            current = null;
            guide.hidden = true;
            tip.hidden = true;
            for (const dot of dots) dot.hidden = true;
        };
        const show = (index) => {
            current = Math.max(0, Math.min(count - 1, index));
            const left = count > 1 ? (current / (count - 1)) * 100 : 50;
            guide.style.left = `${left}%`;
            guide.hidden = false;
            const time = document.createElement("span");
            time.className = "tip-time";
            time.textContent = label(data.t[current], data.step);
            const rows = data.s.map((series) => {
                const row = document.createElement("span");
                row.className = `tip-row tone-${series.c}`;
                const key = document.createElement("span");
                key.className = "tip-key";
                const value = document.createElement("strong");
                value.textContent = series.v[current] === null ? "no data" : number.format(series.v[current]);
                const name = document.createElement("span");
                name.textContent = series.n;
                row.append(key, value, name);
                return row;
            });
            tip.replaceChildren(time, ...rows);
            tip.hidden = false;
            const flip = left > 55;
            tip.style.left = flip ? "auto" : `calc(${left}% + 12px)`;
            tip.style.right = flip ? `calc(${100 - left}% + 12px)` : "auto";
            data.s.forEach((series, position) => {
                const value = series.v[current];
                dots[position].hidden = value === null;
                if (value === null) return;
                dots[position].style.left = `${left}%`;
                dots[position].style.top = `${100 - (value / data.max) * 100}%`;
            });
        };
        const fromPointer = (event) => {
            const box = svg.getBoundingClientRect();
            show(Math.round(((event.clientX - box.left) / box.width) * (count - 1)));
        };
        plot.addEventListener("pointermove", fromPointer);
        plot.addEventListener("pointerdown", fromPointer);
        plot.addEventListener("pointerleave", (event) => {
            if (event.pointerType === "mouse") hide();
        });
        plot.addEventListener("focus", () => show(count - 1));
        plot.addEventListener("blur", hide);
        plot.addEventListener("keydown", (event) => {
            const moves = { ArrowLeft: -1, ArrowRight: 1 };
            if (event.key in moves) show((current ?? count - 1) + moves[event.key]);
            else if (event.key === "Home") show(0);
            else if (event.key === "End") show(count - 1);
            else if (event.key === "Escape") hide();
            else return;
            event.preventDefault();
        });
    }
}

export const chartScript = `(${chartBehavior})();\n`;
