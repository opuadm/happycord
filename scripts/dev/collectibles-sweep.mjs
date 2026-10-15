import { readFileSync } from "node:fs";

const port = process.env.PORT || "3001";
const base = process.env.ORIGIN || `http://localhost:${port}`;
const concurrency = Number(process.env.CONCURRENCY || 6);
const only = process.argv[2];

const accounts = Object.fromEntries(
    readFileSync(new URL("./.test-account", import.meta.url), "utf8")
        .trim()
        .split("\n")
        .map((l) => l.split("=")),
);
const { token } = await fetch(`${base}/api/v9/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ login: accounts.TEST_EMAIL, password: accounts.TEST_PASSWORD }),
}).then((r) => r.json());
if (!token) throw new Error("login failed");

const categories = await fetch(`${base}/api/v9/collectibles-categories?include_bundles=true&include_unpublished=true`, { headers: { authorization: token } }).then((r) => r.json());
const items = new Map();
const walk = (product) => {
    for (const item of product.items ?? []) if (!items.has(item.sku_id) || Object.keys(item).length > Object.keys(items.get(item.sku_id)).length) items.set(item.sku_id, item);
    product.bundled_products?.forEach(walk);
    product.variants?.forEach(walk);
};
for (const category of categories) category.products.forEach(walk);

const local = (url) => {
    const parsed = new URL(url, base);
    return `${parsed.pathname}${parsed.search}`;
};
const shop = (...parts) => `/media/v1/collectibles-shop/${parts.join("/")}`;
const checks = [];
const add = (kind, sku, path, expect) => checks.push({ kind, sku, path, expect });
for (const item of items.values()) {
    if (item.type === 0) {
        add("decoration", item.sku_id, shop(item.sku_id, "static"), "image");
        add("decoration", item.sku_id, shop(item.sku_id, "animated"), "image");
        if (item.asset) {
            add("decoration-preset", item.sku_id, `/avatar-decoration-presets/${item.asset}.png?size=96&passthrough=false`, "image");
            add("decoration-preset", item.sku_id, `/avatar-decoration-presets/${item.asset}.png?size=96&passthrough=true`, "image");
        }
    } else if (item.type === 1) {
        for (const url of [item.thumbnailPreviewSrc, item.reducedMotionSrc, ...(item.effects ?? []).map((x) => x.src)].filter(Boolean))
            add("effect", item.sku_id, local(url), "image");
    } else if (item.type === 2) {
        add("nameplate", item.sku_id, shop(item.sku_id, "static"), "image");
        add("nameplate", item.sku_id, shop(item.sku_id, "animated"), "image");
        add("nameplate", item.sku_id, shop(item.sku_id, "video"), "video");
    } else if (item.type === 3) {
        for (const layer of item.layers ?? []) add("frame", item.sku_id, shop(item.sku_id, layer.id, "static"), "image");
    }
}
const selected = only ? checks.filter((x) => x.kind.startsWith(only)) : checks;
const unique = [...new Map(selected.map((x) => [x.path, x])).values()];
console.log(`${items.size} items, ${unique.length} asset requests`);

const failures = [];
const stats = {};
let done = 0;
const queue = [...unique];
await Promise.all(
    Array.from({ length: concurrency }, async () => {
        for (let check = queue.shift(); check; check = queue.shift()) {
            const stat = (stats[check.kind] ??= { ok: 0, failed: 0 });
            const result = await fetch(`${base}${check.path}`)
                .then(async (r) => ({ status: r.status, type: r.headers.get("content-type") ?? "", size: (await r.arrayBuffer()).byteLength }))
                .catch((e) => ({ status: 0, type: String(e), size: 0 }));
            const ok = result.status === 200 && result.type.startsWith(`${check.expect}/`) && result.size > 0;
            stat[ok ? "ok" : "failed"]++;
            if (!ok) failures.push(`${result.status} ${result.type || "no type"} ${result.size}B ${check.kind} ${check.sku} ${check.path}`);
            if (++done % 200 === 0) console.log(`${done}/${unique.length}, ${failures.length} failed`);
        }
    }),
);
for (const [kind, { ok, failed }] of Object.entries(stats)) console.log(`${kind}: ${ok} ok, ${failed} failed`);
for (const failure of failures) console.log(failure);
process.exitCode = failures.length ? 1 : 0;
