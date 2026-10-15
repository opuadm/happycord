const { sourceMarker } = require("./helpers/source-marker.cjs");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

function load(ReadState) {
    const source = fs.readFileSync(path.join(__dirname, "../../src/api/util/utility/notifications.ts"), "utf8");
    const start = sourceMarker(source, "export async function fillReadStates");
    const end = source.indexOf("\n}\n", start) + 2;
    const js = ts.transpileModule(`${source.slice(start, end).replace("export ", "")}; module.exports = (ids) => fillReadStates("channel", ids);`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const module = { exports: {} };
    let id = 0;
    vm.runInNewContext(js, {
        module,
        ReadState,
        In: (ids) => ids,
        ReadStateType: { CHANNEL: 0 },
        Snowflake: { generate: () => String(++id) },
    });
    return module.exports;
}

function fakeDatabase(beforeInsert = () => {}) {
    const rows = new Map();
    const reads = [],
        inserts = [];
    let active = 0,
        peak = 0;
    return {
        rows,
        reads,
        inserts,
        get peak() {
            return peak;
        },
        async find(options) {
            reads.push(Array.from(options.where.user_id));
            return options.where.user_id.filter((id) => rows.has(id)).map((user_id) => ({ user_id }));
        },
        createQueryBuilder() {
            let values,
                ignore = false;
            return {
                insert() {
                    return this;
                },
                values(value) {
                    values = value;
                    return this;
                },
                orIgnore() {
                    ignore = true;
                    return this;
                },
                async execute() {
                    assert.equal(ignore, true);
                    inserts.push(Array.from(values));
                    peak = Math.max(peak, ++active);
                    try {
                        await beforeInsert(rows, values);
                        for (const row of values) if (!rows.has(row.user_id)) rows.set(row.user_id, row);
                    } finally {
                        active--;
                    }
                },
            };
        },
    };
}

test("concurrent insertion preserves the winning read state without retrying", async () => {
    const winner = { user_id: "new", mention_count: 7, last_message_id: "cursor" };
    const database = fakeDatabase(async (rows) => rows.set("new", winner));
    database.rows.set("existing", { user_id: "existing", mention_count: 5 });
    await load(database)(["existing", "new", "new"]);
    assert.equal(database.reads.length, 1);
    assert.equal(database.inserts.length, 1);
    assert.equal(database.inserts[0].length, 1);
    assert.equal(database.rows.get("new"), winner);
    assert.equal(database.rows.get("existing").mention_count, 5);
});

test("large fanout has bounded SQL batches and no parallel insertion flood", async () => {
    const database = fakeDatabase();
    await load(database)(Array.from({ length: 25003 }, (_, i) => String(i)));
    assert.equal(database.rows.size, 25003);
    assert.equal(database.reads.length, 26);
    assert.equal(database.peak, 1);
    assert.ok(database.reads.every((ids) => ids.length <= 1000));
    assert.ok(database.inserts.every((rows) => rows.length <= 1000));
});

test("unexpected insert and read errors propagate once", async () => {
    const failure = new Error("database unavailable");
    const database = fakeDatabase(async () => {
        throw failure;
    });
    await assert.rejects(load(database)(["user"]), (error) => error === failure);
    assert.equal(database.inserts.length, 1);
    assert.equal(database.reads.length, 1);
    database.find = async () => {
        throw failure;
    };
    await assert.rejects(load(database)(["user"]), (error) => error === failure);
    assert.equal(database.inserts.length, 1);
});

test("empty or already initialized recipients do not issue inserts", async () => {
    const database = fakeDatabase();
    database.rows.set("existing", { user_id: "existing" });
    await load(database)([]);
    assert.equal(database.reads.length, 0);
    await load(database)(["existing"]);
    assert.equal(database.inserts.length, 0);
});

test("Postgres ignores real unique races while rejecting other database failures", { skip: !process.env.READ_STATE_DATABASE }, async () => {
    const { DataSource, EntitySchema, In } = require("typeorm");
    const entity = new EntitySchema({
        name: "ReadStateProbe",
        tableName: "read_state_performance_probe",
        columns: {
            id: { type: String, primary: true },
            user_id: { type: String },
            channel_id: { type: String },
            read_state_type: { type: Number },
        },
        indices: [{ columns: ["channel_id", "user_id"], unique: true }],
    });
    const database = await new DataSource({
        type: "postgres",
        url: process.env.READ_STATE_DATABASE,
        entities: [entity],
        synchronize: false,
    }).initialize();
    const runner = database.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
        await runner.query(
            "CREATE TEMPORARY TABLE read_state_performance_probe (id text PRIMARY KEY, user_id text NOT NULL, channel_id text NOT NULL, read_state_type integer NOT NULL, UNIQUE (channel_id, user_id), CHECK (user_id <> 'invalid')) ON COMMIT DROP",
        );
        const repository = runner.manager.getRepository(entity);
        const adapter = {
            find: async (options) =>
                repository.find({
                    ...options,
                    where: { ...options.where, user_id: In(options.where.user_id) },
                }),
            createQueryBuilder: () => repository.createQueryBuilder(),
        };
        const fill = load(adapter);
        await Promise.all([fill(["same"]), fill(["same"])]);
        assert.equal(await repository.count(), 1);
        await assert.rejects(fill(["invalid"]), (error) => error.driverError.code === "23514");
    } finally {
        await runner.rollbackTransaction();
        await runner.release();
        await database.destroy();
    }
});
