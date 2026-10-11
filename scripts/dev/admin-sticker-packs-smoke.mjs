/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";

const playwright = createRequire(path.join(homedir(), ".cache/fosscord-tools/package.json"))("playwright-core");
const origin = process.env.ORIGIN || `http://localhost:${process.env.PORT || 3001}`;
assert.ok(["localhost", "127.0.0.1", "fosscord.localhost"].includes(new URL(origin).hostname));
assert.ok(process.env.TEST_ACCOUNT_PATH, "Provide the isolated seeded account file");
const account = Object.fromEntries(
    readFileSync(process.env.TEST_ACCOUNT_PATH, "utf8")
        .trim()
        .split("\n")
        .map((line) => {
            const at = line.indexOf("=");
            return [line.slice(0, at), line.slice(at + 1)];
        }),
);
assert.ok(account.TEST_EMAIL && account.TEST_PASSWORD);

const crcTable = Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
});
const crc = (buffer) => {
    let value = 0xffffffff;
    for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, checksum]);
};
const frameControl = (sequence, size) => {
    const data = Buffer.alloc(26);
    data.writeUInt32BE(sequence, 0);
    data.writeUInt32BE(size, 4);
    data.writeUInt32BE(size, 8);
    data.writeUInt16BE(1, 20);
    data.writeUInt16BE(2, 22);
    return chunk("fcTL", data);
};
function png([red, green, blue], animated = false) {
    const size = 64;
    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header[8] = 8;
    header[9] = 6;
    const pixels = (r, g, b) => {
        const rows = Buffer.alloc((size * 4 + 1) * size);
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) rows.set([r, g, b, 255], y * (size * 4 + 1) + 1 + x * 4);
        return deflateSync(rows);
    };
    const chunks = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header)];
    if (animated) {
        const frames = Buffer.alloc(8);
        frames.writeUInt32BE(2, 0);
        chunks.push(chunk("acTL", frames), frameControl(0, size));
    }
    chunks.push(chunk("IDAT", pixels(red, green, blue)));
    if (animated) {
        const sequence = Buffer.alloc(4);
        sequence.writeUInt32BE(2);
        chunks.push(frameControl(1, size), chunk("fdAT", Buffer.concat([sequence, pixels(blue, red, green)])));
    }
    chunks.push(chunk("IEND", Buffer.alloc(0)));
    return Buffer.concat(chunks);
}
const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);
const lottie = (extra = {}) => Buffer.from(JSON.stringify({ v: "5.7.4", fr: 30, ip: 0, op: 30, w: 320, h: 320, nm: "smoke", ddd: 0, assets: [], layers: [], ...extra }));
const dataUri = (buffer, type) => `data:${type};base64,${buffer.toString("base64")}`;

const api = `${origin}/api/v9`;
async function login(email, password) {
    const response = await fetch(`${api}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ login: email, password }),
    });
    assert.equal(response.status, 200, "isolated account login");
    return (await response.json()).token;
}
const operator = await login(account.TEST_EMAIL, account.TEST_PASSWORD);
async function request(expected, method, route, body, token = operator) {
    const response = await fetch(api + route, {
        method,
        headers: { authorization: token, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    assert.equal(response.status, expected, `${method} ${route}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
}
const adminPack = async (id) => (await request(200, "GET", "/admin/sticker-packs")).packs.find((pack) => pack.id === id);
const publicPacks = async () => (await request(200, "GET", "/sticker-packs")).sticker_packs;

const created = new Set();
const browserName = process.env.BROWSER || "chromium";
assert.ok(["chromium", "webkit"].includes(browserName));
let browser;
try {
    if (account.FRIEND_PASSWORD) {
        const member = await login("friend@fosscord.test", account.FRIEND_PASSWORD);
        await request(403, "GET", "/admin/sticker-packs", undefined, member);
        await request(403, "POST", "/admin/sticker-packs", { name: "Not allowed" }, member);
    }

    const listing = await request(200, "GET", "/admin/sticker-packs");
    assert.ok(Array.isArray(listing.packs));
    assert.equal(typeof listing.import_enabled, "boolean");
    assert.ok(listing.limits.stickers_per_pack > 0 && listing.limits.file_bytes > 0);

    await request(400, "POST", "/admin/sticker-packs", { name: "   " });
    const pack = await request(201, "POST", "/admin/sticker-packs", { name: "  Smoke pack  ", description: " First pack ", position: -5 });
    created.add(pack.id);
    assert.deepEqual(
        { ...pack, id: undefined },
        { id: undefined, name: "Smoke pack", description: "First pack", position: -5, hidden: false, cover_sticker_id: null, stickers: [] },
    );
    assert.ok(!(await publicPacks()).some((entry) => entry.id === pack.id), "an empty pack stays out of the picker");

    const stickers = `/admin/sticker-packs/${pack.id}/stickers`;
    const still = await request(201, "POST", stickers, { name: "Still", tags: "still, calm", description: "A still square", file_data: dataUri(png([200, 40, 90]), "image/png") });
    const moving = await request(201, "POST", stickers, { name: "Moving", file_data: dataUri(png([40, 90, 200], true), "image/png") });
    const looping = await request(201, "POST", stickers, { name: "Looping", file_data: dataUri(gif, "image/gif") });
    const vector = await request(201, "POST", stickers, { name: "Vector", file_data: dataUri(lottie(), "application/json") });
    assert.deepEqual(
        [still, moving, looping, vector].map((sticker) => [sticker.format_type, sticker.sort_value, sticker.pack_id]),
        [
            [1, 0, pack.id],
            [2, 1, pack.id],
            [4, 2, pack.id],
            [3, 3, pack.id],
        ],
    );
    assert.equal(still.uploaded, true);
    assert.equal(still.tags, "still, calm");
    assert.equal(still.description, "A still square");
    assert.equal(moving.tags, "");

    for (const [file_data, reason] of [
        [dataUri(jpeg, "image/jpeg"), "JPEG"],
        [dataUri(lottie({ assets: [{ id: "a", u: "images/", p: "a.png" }] }), "application/json"), "Lottie with an image path"],
        [dataUri(lottie({ nm: "https://tracker.invalid/pixel" }), "application/json"), "Lottie with an outside address"],
        [dataUri(Buffer.from("{not json"), "application/json"), "broken JSON"],
        ["not a data uri", "plain text"],
    ]) {
        const refused = await fetch(api + stickers, {
            method: "POST",
            headers: { authorization: operator, "content-type": "application/json" },
            body: JSON.stringify({ name: "Refused", file_data }),
        });
        assert.equal(refused.status, 400, reason);
    }
    await request(400, "POST", stickers, { name: "x", file_data: dataUri(gif, "image/gif") });
    await request(404, "POST", "/admin/sticker-packs/1/stickers", { name: "Nowhere", file_data: dataUri(gif, "image/gif") });
    await request(404, "POST", "/admin/sticker-packs/99999999999999999999/stickers", { name: "Nowhere", file_data: dataUri(gif, "image/gif") });
    assert.equal((await adminPack(pack.id)).stickers.length, 4, "refused uploads add nothing");

    for (const [sticker, type] of [
        [still, "image/png"],
        [moving, "image/apng"],
        [looping, "image/gif"],
        [vector, "application/json"],
    ]) {
        const artwork = await fetch(sticker.url);
        assert.equal(artwork.status, 200);
        assert.ok(artwork.headers.get("content-type").startsWith(type), `${sticker.name} is served as ${type}`);
    }

    const listed = (await publicPacks()).find((entry) => entry.id === pack.id);
    assert.ok(listed, "a pack with stickers reaches the picker");
    assert.ok(!("pack_upload" in listed.stickers[0]));
    assert.deepEqual(
        listed.stickers.map((sticker) => [sticker.name, sticker.type, sticker.format_type, sticker.pack_id, sticker.available]),
        [
            ["Still", 1, 1, pack.id, true],
            ["Moving", 1, 2, pack.id, true],
            ["Looping", 1, 4, pack.id, true],
            ["Vector", 1, 3, pack.id, true],
        ],
    );
    assert.equal((await request(200, "GET", `/sticker-packs/${pack.id}`)).stickers.length, 4);

    assert.equal((await request(200, "PATCH", `/admin/sticker-packs/${pack.id}`, { hidden: true })).hidden, true);
    assert.ok(!(await publicPacks()).some((entry) => entry.id === pack.id), "a hidden pack stays out of the picker");
    assert.equal((await request(200, "GET", `/sticker-packs/${pack.id}`)).stickers.length, 4, "a hidden pack still resolves for stickers already sent");
    assert.equal((await fetch(still.url)).status, 200);
    assert.equal((await request(200, "PATCH", `/admin/sticker-packs/${pack.id}`, { hidden: false })).hidden, false);
    assert.ok((await publicPacks()).some((entry) => entry.id === pack.id));

    const other = await request(201, "POST", "/admin/sticker-packs", { name: "Smoke destination", position: -6 });
    created.add(other.id);
    const guest = await request(201, "POST", `/admin/sticker-packs/${other.id}/stickers`, { name: "Guest", file_data: dataUri(gif, "image/gif") });
    const ordered = (await publicPacks()).map((entry) => entry.id);
    assert.ok(ordered.indexOf(other.id) < ordered.indexOf(pack.id), "a lower position comes first");

    await request(400, "PATCH", `/admin/sticker-packs/${pack.id}`, { cover_sticker_id: guest.id });
    await request(400, "PATCH", `/admin/sticker-packs/${pack.id}`, { name: " " });
    const covered = await request(200, "PATCH", `/admin/sticker-packs/${pack.id}`, { name: "Smoke pack renamed", description: "", position: -7, cover_sticker_id: looping.id });
    assert.deepEqual([covered.name, covered.description, covered.position, covered.cover_sticker_id, covered.stickers.length], ["Smoke pack renamed", "", -7, looping.id, 4]);
    assert.equal((await publicPacks()).find((entry) => entry.id === pack.id).cover_sticker_id, looping.id);
    const reordered = (await publicPacks()).map((entry) => entry.id);
    assert.ok(reordered.indexOf(pack.id) < reordered.indexOf(other.id));

    const edited = await request(200, "PATCH", `${stickers}/${vector.id}`, { name: "  Vector first ", tags: "vector, shape", description: "A shape", sort_value: -1 });
    assert.deepEqual([edited.name, edited.tags, edited.description, edited.sort_value], ["Vector first", "vector, shape", "A shape", -1]);
    assert.equal((await adminPack(pack.id)).stickers[0].id, vector.id, "a lower sort value comes first");
    await request(404, "PATCH", `/admin/sticker-packs/${other.id}/stickers/${vector.id}`, { name: "Wrong pack" });
    await request(404, "PATCH", `${stickers}/${vector.id}`, { pack_id: "1" });

    const replaced = await request(200, "PATCH", `${stickers}/${still.id}`, { file_data: dataUri(gif, "image/gif") });
    assert.equal(replaced.format_type, 4);
    assert.notEqual(replaced.url, still.url);
    assert.ok((await fetch(replaced.url)).headers.get("content-type").startsWith("image/gif"));
    await request(400, "PATCH", `${stickers}/${still.id}`, { file_data: dataUri(jpeg, "image/jpeg") });
    assert.ok((await fetch(replaced.url)).headers.get("content-type").startsWith("image/gif"), "a refused replacement keeps the artwork");

    const moved = await request(200, "PATCH", `${stickers}/${looping.id}`, { pack_id: other.id });
    assert.deepEqual([moved.pack_id, moved.sort_value], [other.id, 1]);
    assert.equal((await adminPack(pack.id)).cover_sticker_id, null, "moving the cover sticker away clears the cover");
    assert.deepEqual(
        (await adminPack(other.id)).stickers.map((sticker) => sticker.id),
        [guest.id, looping.id],
    );

    await request(200, "PATCH", `/admin/sticker-packs/${pack.id}`, { cover_sticker_id: moving.id });
    await request(204, "DELETE", `${stickers}/${moving.id}`);
    assert.equal((await adminPack(pack.id)).cover_sticker_id, null, "deleting the cover sticker clears the cover");
    assert.equal((await fetch(moving.url)).status, 404);
    await request(404, "DELETE", `${stickers}/${moving.id}`);

    await request(204, "DELETE", `/admin/sticker-packs/${other.id}`);
    created.delete(other.id);
    assert.equal(await adminPack(other.id), undefined);
    for (const sticker of [guest, looping]) assert.equal((await fetch(sticker.url)).status, 404, "deleting a pack removes its artwork");
    await request(404, "GET", `/sticker-packs/${other.id}`);

    browser = await playwright[browserName].launch(
        browserName === "chromium"
            ? {
                  executablePath: process.env.CHROME_PATH || "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
                  headless: true,
              }
            : { headless: true },
    );
    const errors = [];
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "dark" });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/admin`);
    await page.locator('#login-form input[name="login"]').fill(account.TEST_EMAIL);
    await page.locator('#login-form input[name="password"]').fill(account.TEST_PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.locator("#nav-search").waitFor();
    await page.locator('#nav a[data-tab="stickers"]').click();
    await page.locator(`tr[data-sticker-pack="${pack.id}"]`).waitFor();

    await page.locator("#new-sticker-pack").click();
    await page.locator('#sticker-pack-form input[name="name"]').fill("Smoke dashboard pack");
    await page.locator("#sticker-pack-form").getByRole("button", { name: "Add pack", exact: true }).click();
    await page.locator("#sticker-add").waitFor();
    const dashboardPack = (await request(200, "GET", "/admin/sticker-packs")).packs.find((entry) => entry.name === "Smoke dashboard pack");
    assert.ok(dashboardPack);
    created.add(dashboardPack.id);

    await page.locator("#sticker-files").setInputFiles([
        { name: "happy_cat.png", mimeType: "image/png", buffer: png([250, 180, 40]) },
        { name: "wave-hello.gif", mimeType: "image/gif", buffer: gif },
        { name: "x.jpg", mimeType: "image/jpeg", buffer: jpeg },
    ]);
    await page.locator(".sticker-tile").nth(1).waitFor();
    assert.deepEqual(await page.locator(".sticker-tile span").allTextContents(), ["happy cat", "wave hello"]);
    assert.equal(await page.locator(".sticker-tile img.sticker-thumb").count(), 2);
    if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, "sticker-pack-drawer.png") });

    await page.locator(".sticker-tile", { hasText: "happy cat" }).click();
    await page.locator('#sticker-form input[name="name"]').fill("Happy cat");
    await page.locator('#sticker-form input[name="tags"]').fill("cat, happy");
    if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, "sticker-drawer.png") });
    await page.locator("#sticker-form").getByRole("button", { name: "Save", exact: true }).click();
    await page.locator(".sticker-tile", { hasText: "Happy cat" }).waitFor();
    const renamed = (await adminPack(dashboardPack.id)).stickers.find((sticker) => sticker.name === "Happy cat");
    assert.equal(renamed.tags, "cat, happy");

    await page.locator('#sticker-pack-form select[name="cover_sticker_id"]').selectOption({ label: "wave hello" });
    await page.locator("#sticker-pack-form").getByRole("button", { name: "Save pack", exact: true }).click();
    await page.locator(".toast", { hasText: "Pack saved" }).waitFor();
    const saved = await adminPack(dashboardPack.id);
    assert.equal(saved.cover_sticker_id, saved.stickers.find((sticker) => sticker.name === "wave hello").id);

    await page.locator(".drawer-head button").click();
    await page.locator("#drawer").waitFor({ state: "hidden" });
    if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, "sticker-packs.png") });
    await page.locator(`tr[data-sticker-pack="${dashboardPack.id}"]`).click();
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#sticker-pack-delete").click();
    await page.locator("#drawer").waitFor({ state: "hidden" });
    await page.locator(`tr[data-sticker-pack="${dashboardPack.id}"]`).waitFor({ state: "detached" });
    assert.equal(await adminPack(dashboardPack.id), undefined);
    created.delete(dashboardPack.id);

    const bulk = [];
    for (const name of ["Smoke bulk one", "Smoke bulk two"]) {
        const entry = await request(201, "POST", "/admin/sticker-packs", { name });
        created.add(entry.id);
        bulk.push(entry.id);
    }
    await page.locator('#nav a[data-tab="store"]').click();
    await page.locator('#nav a[data-tab="stickers"]').click();
    const select = async () => {
        for (const id of bulk) await page.locator(`[data-select-pack="${id}"]`).check();
        assert.equal(await page.locator("#sticker-pack-count").textContent(), "2 selected");
    };
    await page.locator(`[data-select-pack="${bulk[1]}"]`).waitFor();
    assert.equal(await page.locator("#sticker-pack-bulk").isHidden(), true);
    await select();
    await page.locator('[data-bulk="hide"]').click();
    for (const id of bulk) await page.locator(`tr[data-sticker-pack="${id}"] .badge`, { hasText: "Hidden" }).waitFor();
    for (const id of bulk) assert.equal((await adminPack(id)).hidden, true);
    await select();
    await page.locator('[data-bulk="show"]').click();
    for (const id of bulk) await page.locator(`tr[data-sticker-pack="${id}"] .badge`, { hasText: "Empty" }).waitFor();
    for (const id of bulk) assert.equal((await adminPack(id)).hidden, false);
    await select();
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator('[data-bulk="delete"]').click();
    for (const id of bulk) await page.locator(`tr[data-sticker-pack="${id}"]`).waitFor({ state: "detached" });
    for (const id of bulk) {
        assert.equal(await adminPack(id), undefined);
        created.delete(id);
    }
    assert.deepEqual(errors, []);
    console.log(`admin sticker packs smoke passed in ${browserName}`);
} finally {
    await browser?.close();
    for (const id of created) await fetch(`${api}/admin/sticker-packs/${id}`, { method: "DELETE", headers: { authorization: operator } });
}
