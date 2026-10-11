/* SPDX-License-Identifier: AGPL-3.0-only */
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const vm = require("node:vm");
const ts = require("typescript");

function registeredRoutes(file) {
    const routes = [];
    const module = { exports: {} };
    const js = ts.transpileModule(readFileSync(file, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const register = (method) => (routePath, options) => routes.push({ method, path: routePath, ...options });
    vm.runInNewContext(js, {
        module,
        exports: module.exports,
        require(name) {
            if (name === "express") return { Router: () => ({ get: register("GET"), post: register("POST"), patch: register("PATCH"), delete: register("DELETE") }) };
            if (name === "@spacebar/api/middlewares") return { route: (options) => options };
            return {};
        },
    });
    return routes;
}

test("every sticker pack admin route needs the operator right and validates its body", () => {
    const routes = ["index.ts", "#pack_id/index.ts", "#pack_id/stickers.ts"].flatMap((file) =>
        registeredRoutes(path.join("src/api/routes/admin/sticker-packs", file)).map((route) => ({ file, ...route })),
    );
    assert.deepEqual(
        routes.map((route) => `${route.file} ${route.method} ${route.path} ${route.requestBody ?? "-"}`),
        [
            "index.ts GET / -",
            "index.ts POST / AdminStickerPackCreateSchema",
            "#pack_id/index.ts PATCH / AdminStickerPackUpdateSchema",
            "#pack_id/index.ts DELETE / -",
            "#pack_id/stickers.ts POST / AdminStickerCreateSchema",
            "#pack_id/stickers.ts PATCH /:sticker_id AdminStickerUpdateSchema",
            "#pack_id/stickers.ts DELETE /:sticker_id -",
        ],
    );
    for (const route of routes) {
        assert.equal(route.right, "OPERATOR", `${route.method} ${route.file}`);
        assert.equal(route.spacebarOnly, true, `${route.method} ${route.file}`);
    }
    const schemas = JSON.parse(readFileSync("assets/schemas.json", "utf8"));
    for (const name of ["AdminStickerPackCreateSchema", "AdminStickerPackUpdateSchema", "AdminStickerCreateSchema", "AdminStickerUpdateSchema"])
        assert.equal(schemas[name]?.additionalProperties, false, name);
    assert.deepEqual(schemas.AdminStickerCreateSchema.required.sort(), ["file_data", "name"]);
    assert.deepEqual([schemas.AdminStickerCreateSchema.properties.name.minLength, schemas.AdminStickerCreateSchema.properties.name.maxLength], [2, 30]);
});

test("uploaded pack stickers stay out of the Discord artwork mirror and fallback", () => {
    assert.match(readFileSync("scripts/provision-stickers.mjs", "utf8"), /FROM stickers WHERE type = 1 AND NOT pack_upload ORDER BY id/);
    assert.match(readFileSync("src/cdn/routes/stickers.ts", "utf8"), /where: \{ id: sticker_id, type: StickerType\.STANDARD, pack_upload: false \}/);
    assert.match(
        readFileSync("src/api/routes/admin/sticker-packs/#pack_id/stickers.ts", "utf8"),
        /type: StickerType\.STANDARD,\s+format_type,\s+available: true,\s+pack_upload: true,/,
    );
});

test("the dashboard lists the sticker packs page for operators", () => {
    const page = readFileSync("assets/public/admin/index.html", "utf8");
    assert.match(page, /<a href="#\/stickers" data-tab="stickers" data-access="settings">Sticker packs<\/a>/);
    const script = readFileSync("assets/public/admin/admin.js", "utf8");
    assert.match(script, /stickers: renderStickerPacks,/);
});

test("sticker packs order, hide, clear covers, validate artwork and migrate repeatedly on SQLite", { timeout: 30_000 }, async () => {
    if (process.env.STICKER_PACK_TEST_CHILD !== "1") {
        const directory = mkdtempSync(path.join(tmpdir(), "meowcord-sticker-pack-test-"));
        try {
            writeFileSync(
                path.join(directory, "config.json"),
                JSON.stringify({
                    general: { serverName: "http://localhost:3001" },
                    api: { endpointPublic: "http://localhost:3001/api/v9" },
                    cdn: { endpointPublic: "http://localhost:3001/", endpointPrivate: "http://localhost:3001" },
                    gateway: { endpointPublic: "ws://localhost:3001" },
                }),
            );
            const result = spawnSync(process.execPath, ["test", __filename], {
                env: {
                    ...process.env,
                    STICKER_PACK_TEST_CHILD: "1",
                    APPLY_DB_MIGRATIONS: "true",
                    DB_LOGGING: "",
                    DATABASE: `sqlite:${path.join(directory, "database.sqlite")}`,
                    DB_SYNC: "",
                    CONFIG_PATH: path.join(directory, "config.json"),
                },
                encoding: "utf8",
                timeout: 25_000,
            });
            assert.equal(result.status, 0, result.stdout + result.stderr);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
        return;
    }
    const { initDatabase, closeDatabase } = require("../../dist/database");
    const { Sticker, StickerPack } = require("../../dist/database/entities");
    const { Config } = require("../../dist/util/util/Config.js");
    const { StickerPackCuration1791950314629 } = require("../../dist/database/migration/sqlite/1791950314629-StickerPackCuration.js");
    const packs = require("../../dist/api/util/utility/StickerPacks.js");
    try {
        const database = await initDatabase();
        await Config.init();
        const tableColumns = async (table) => (await database.query(`PRAGMA table_info("${table}")`)).map((column) => column.name);
        const addedColumns = async () => [
            ...(await tableColumns("sticker_packs")).filter((name) => ["position", "hidden"].includes(name)),
            ...(await tableColumns("stickers")).filter((name) => name === "pack_upload"),
        ];
        assert.deepEqual(await addedColumns(), ["position", "hidden", "pack_upload"]);

        const pack = (name, values = {}) => StickerPack.create({ name, ...values }).save();
        const sticker = (pack_id, name, sort_value) => Sticker.create({ pack_id, name, tags: "", type: 1, format_type: 1, available: true, sort_value }).save();
        const late = await pack("Late", { position: 5 });
        const early = await pack("Early", { position: -5 });
        const first = await pack("Default first");
        const second = await pack("Default second");
        const hidden = await pack("Hidden", { position: -9, hidden: true });
        const empty = await pack("Empty", { position: -8 });
        assert.ok(BigInt(first.id) < BigInt(second.id));
        const zebra = await sticker(early.id, "Zebra", 2);
        const apple = await sticker(early.id, "Apple", 1);
        const tied = await sticker(early.id, "Tied", 1);
        for (const entry of [late, first, second, hidden]) await sticker(entry.id, `In ${entry.name}`, 0);

        const runner = database.createQueryRunner();
        try {
            const migration = new StickerPackCuration1791950314629();
            await migration.up(runner);
            await migration.down(runner);
            assert.deepEqual(await addedColumns(), []);
            await migration.down(runner);
            await migration.up(runner);
            assert.deepEqual(await addedColumns(), ["position", "hidden", "pack_upload"]);
            const defaults = await database.query(`SELECT DISTINCT position, hidden FROM sticker_packs`);
            assert.deepEqual(
                defaults.map((row) => [Number(row.position), Number(row.hidden)]),
                [[0, 0]],
            );
        } finally {
            await runner.release();
        }
        await StickerPack.update({ id: late.id }, { position: 5 });
        await StickerPack.update({ id: early.id }, { position: -5 });
        await StickerPack.update({ id: hidden.id }, { position: -9, hidden: true });
        await StickerPack.update({ id: empty.id }, { position: -8 });

        assert.deepEqual(
            (await packs.findPickerStickerPacks()).map((entry) => entry.name),
            ["Early", "Default first", "Default second", "Late"],
        );
        assert.deepEqual(
            (await packs.findStickerPacks()).map((entry) => entry.name),
            ["Hidden", "Empty", "Early", "Default first", "Default second", "Late"],
        );
        const ordered = await packs.findStickerPack(early.id);
        assert.deepEqual(
            ordered.stickers.map((entry) => entry.id),
            [apple.id, tied.id, zebra.id],
        );
        assert.equal((await packs.findStickerPack(hidden.id)).stickers.length, 1);
        assert.equal(await packs.findStickerPack("1"), null);
        assert.equal(await packs.nextStickerSortValue(early.id), 3);
        assert.equal(await packs.nextStickerSortValue(empty.id), 0);

        await StickerPack.update({ id: early.id }, { cover_sticker_id: apple.id, cover_sticker: { id: apple.id } });
        await StickerPack.update({ id: late.id }, { cover_sticker_id: zebra.id });
        const serialized = packs.serializeAdminStickerPack(await packs.findStickerPack(early.id));
        assert.deepEqual(
            { ...serialized, stickers: serialized.stickers.length },
            { id: early.id, name: "Early", description: "", position: -5, hidden: false, cover_sticker_id: apple.id, stickers: 3 },
        );
        const { url, ...details } = serialized.stickers[0];
        assert.deepEqual(details, { id: apple.id, pack_id: early.id, name: "Apple", description: "", tags: "", format_type: 1, sort_value: 1, uploaded: false });
        assert.match(url, new RegExp(`^http://localhost:3001/stickers/${apple.id}\\?v=[1-9][0-9]+$`));
        const uploaded = await Sticker.create({ pack_id: late.id, name: "Uploaded", tags: "", type: 1, format_type: 1, available: true, sort_value: 9, pack_upload: true }).save();
        const reloaded = await Sticker.findOneByOrFail({ id: uploaded.id });
        assert.equal(packs.serializeAdminSticker(reloaded).uploaded, true);
        assert.ok(!("pack_upload" in reloaded.toJSON()));
        assert.equal(reloaded.toJSON().pack_id, late.id);
        await Sticker.update({ id: apple.id }, { name: "Apple renamed" });
        assert.notEqual(packs.serializeAdminSticker(await Sticker.findOneByOrFail({ id: apple.id })).url, url);
        await assert.rejects(Sticker.delete({ id: apple.id }));
        await database.transaction(async (manager) => {
            await packs.clearStickerPackCover(manager, apple.id);
            await packs.clearStickerPackCover(manager, zebra.id);
            await manager.delete(Sticker, { id: apple.id });
        });
        assert.deepEqual(
            (await database.query(`SELECT cover_sticker_id, "coverStickerId" FROM sticker_packs WHERE id IN ($1, $2)`, [early.id, late.id])).map((row) => Object.values(row)),
            [
                [null, null],
                [null, null],
            ],
        );

        for (const [value, valid] of [
            [early.id, true],
            ["9223372036854775807", true],
            ["9223372036854775808", false],
            ["99999999999999999999", false],
            ["12a", false],
            ["", false],
            [12, false],
            [undefined, false],
        ])
            assert.equal(packs.isStickerId(value), valid, String(value));
        await assert.rejects(packs.knownStickerPackId("1"), (error) => error.code === 404);
        await assert.rejects(packs.knownStickerPackId("abc"), (error) => error.code === 404);
        assert.equal(await packs.knownStickerPackId(early.id), early.id);
        assert.throws(
            () => packs.stickerName(" a "),
            (error) => error.code === 400,
        );
        assert.equal(packs.stickerName("  Wave  "), "Wave");

        const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
        const chunk = (type, length) => {
            const data = Buffer.alloc(12 + length);
            data.writeUInt32BE(length, 0);
            data.write(type, 4, "ascii");
            return data;
        };
        const header = chunk("IHDR", 13);
        header.writeUInt32BE(1, 8);
        header.writeUInt32BE(1, 12);
        header[16] = 8;
        header[17] = 6;
        const still = Buffer.concat([signature, header, chunk("IDAT", 4), chunk("IEND", 0)]);
        const animated = Buffer.concat([signature, header, chunk("acTL", 8), chunk("IDAT", 4), chunk("IEND", 0)]);
        const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
        const webp = Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64");
        const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);
        const lottie = (extra = {}) => Buffer.from(JSON.stringify({ v: "5.7.4", fr: 30, ip: 0, op: 30, w: 320, h: 320, assets: [], layers: [], ...extra }));
        const embedded = "data:image/png;base64,iVBORw0KGgo=";
        for (const [buffer, format] of [
            [still, 1],
            [webp, 1],
            [animated, 2],
            [lottie(), 3],
            [lottie({ assets: [{ id: "image", p: embedded, e: 1 }] }), 3],
            [gif, 4],
        ])
            assert.equal(await packs.stickerArtFormat(buffer), format);
        for (const buffer of [
            jpeg,
            Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"),
            Buffer.alloc(0),
            Buffer.from("{not json"),
            lottie({ layers: undefined }),
            lottie({ w: 0 }),
            lottie({ fr: 0 }),
            lottie({ nm: "https://tracker.invalid/pixel" }),
            lottie({ layers: [{ refId: "//tracker.invalid/a" }] }),
            lottie({ assets: [{ id: "image", u: "images/", p: "a.png" }] }),
            lottie({ assets: [{ id: "image", p: "a.png" }] }),
        ])
            await assert.rejects(packs.stickerArtFormat(buffer), (error) => error.code === 400);
        await assert.rejects(packs.uploadStickerArt("1", "plain text"), (error) => error.code === 400);
        await assert.rejects(
            packs.uploadStickerArt("1", `data:image/gif;base64,${Buffer.alloc(packs.STICKER_PACK_LIMITS.file_bytes + 1).toString("base64")}`),
            (error) => error.code === 400,
        );
        await assert.rejects(packs.uploadStickerArt("1", `data:image/jpeg;base64,${jpeg.toString("base64")}`), (error) => error.code === 400);
    } finally {
        await closeDatabase();
    }
});
