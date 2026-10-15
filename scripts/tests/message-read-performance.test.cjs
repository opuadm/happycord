const { sourceMarker } = require("./helpers/source-marker.cjs");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

function load(relative, database) {
    const js = ts.transpileModule(fs.readFileSync(path.join(__dirname, "../..", relative), "utf8"), {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
        },
    }).outputText;
    const module = { exports: {} };
    const router = { get() {}, post() {}, patch() {}, delete() {} };
    const context = vm.createContext({
        module,
        exports: module.exports,
        console,
        Buffer,
        require(id) {
            if (id === "@spacebar/database") return database;
            if (id === "@spacebar/api/middlewares") return { route: () => () => {} };
            if (id === "@spacebar/api/util") return {};
            if (id === "@spacebar/api/util/utility/federationAuthorship") return { relayedAuthorship: () => undefined };
            if (id === "express") return { Router: () => router };
            if (id === "multer") return Object.assign(() => ({ any: () => () => {} }), { memoryStorage: () => ({}) });
            if (id === "@spacebar/util")
                return {
                    Config: { get: () => ({ limits: { message: {} } }) },
                    MessageFlags: { FLAGS: { EPHEMERAL: 64 } },
                    FieldErrors: (x) => new Error(JSON.stringify(x)),
                };
            if (id === "@spacebar/schemas")
                return {
                    MessageType: { DEFAULT: 0, REPLY: 19, APPLICATION_COMMAND: 20, CONTEXT_MENU_COMMAND: 23 },
                    PublicUserProjection: ["id", "username"],
                };
            if (id === "lambert-server/HTTPError")
                return {
                    HTTPError: class extends Error {
                        constructor(message, status) {
                            super(message);
                            this.status = status;
                        }
                    },
                };
            return require(id);
        },
    });
    vm.runInContext(js, context, { filename: relative });
    return module.exports;
}

const searchFile = "src/api/util/utility/MessageSearch.ts";
test("search filters ephemeral rows before both count and pagination, avoids relation joins, and keeps ranked order", async () => {
    const calls = [];
    const qb = {
        select() {
            return this;
        },
        where() {
            return this;
        },
        andWhere(sql, values) {
            calls.push(["predicate", sql, values]);
            return this;
        },
        async getCount() {
            calls.push(["count"]);
            return 2;
        },
        orderBy() {
            return this;
        },
        offset(value) {
            assert.equal(value, 0);
            return this;
        },
        limit(value) {
            assert.equal(value, 25);
            return this;
        },
        async getRawMany() {
            calls.push(["page"]);
            return [{ id: "2" }, { id: "1" }];
        },
    };
    const { searchMessages } = load(searchFile, {
        Message: {
            createQueryBuilder: () => qb,
            find: async (options) => {
                assert.equal(options.relationLoadStrategy, "query");
                return [{ id: "1" }, { id: "2" }];
            },
            fillReplies: async () => {},
        },
    });
    const result = await searchMessages("user", [{ id: "channel" }], {});
    assert.deepEqual(
        Array.from(result.messages, (m) => m.id),
        ["2", "1"],
    );
    assert.equal(result.total_results, 2);
    const filter = calls.findIndex((x) => x[0] === "predicate" && x[1].includes("m.flags"));
    assert.ok(filter >= 0 && filter < calls.findIndex((x) => x[0] === "count"));
    assert.equal(calls[filter][2].ephemeral, 64);
});

test("invalid or costly pagination and tab fanout fail before accessing the database", async () => {
    const { searchMessages, searchTabs } = load(searchFile, {
        Message: {
            createQueryBuilder: () => {
                throw new Error("database touched");
            },
        },
    });
    for (const offset of [-1, 0.5, NaN, Infinity, "nope", 5001, Number.MAX_SAFE_INTEGER + 1]) {
        await assert.rejects(searchMessages("user", [{ id: "channel" }], { offset }), (error) => error.status === 422);
    }
    for (const limit of [0, 0.5, NaN, Infinity, 101]) {
        await assert.rejects(searchMessages("user", [{ id: "channel" }], { limit }), (error) => error.status === 422);
    }
    await assert.rejects(
        searchTabs("user", [], {
            tabs: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`tab${i}`, {}])),
        }),
        (error) => error.status === 422,
    );
});

test("interaction hydration deduplicates users, projects public fields, supports modern-only metadata, and tolerates deleted users", async () => {
    let reads = 0;
    const { fillInteractionUsers } = load("src/api/routes/channels/#channel_id/messages/index.ts", {
        User: {
            find: async (options) => {
                reads++;
                assert.equal(options.where.id.value.length, 2);
                assert.deepEqual(Object.keys(options.select), ["id", "username"]);
                return [{ id: "1", email: "private", toPublicUser: () => ({ id: "1", username: "Public" }) }];
            },
        },
    });
    const messages = [
        { interaction_metadata: { user_id: "1" } },
        { interaction_metadata: { user_id: "1" }, interaction: {} },
        { interaction_metadata: { user_id: "deleted" } },
        {},
    ];
    await fillInteractionUsers(messages);
    assert.equal(reads, 1);
    assert.equal(messages[0].interaction_metadata.user.username, "Public");
    assert.equal(messages[0].interaction_metadata.user.email, undefined);
    assert.equal(messages[1].interaction.user, messages[0].interaction_metadata.user);
    assert.equal(messages[2].interaction_metadata.user, undefined);
    await fillInteractionUsers([{}, { interaction_metadata: { user_id: "1", user: { id: "1" } } }]);
    assert.equal(reads, 1);
});

test("reply hydration batches shared references, reuses in-page messages, and uses separate relation queries", async () => {
    const source = fs.readFileSync(path.join(__dirname, "../../src/database/entities/Message.ts"), "utf8");
    const method = source.slice(sourceMarker(source, "    static async fillReplies("), sourceMarker(source, "    static publicReactions("));
    const js = ts.transpileModule(`class Message { ${method} }; module.exports = Message;`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const module = { exports: {} };
    vm.runInNewContext(js, {
        module,
        In: (ids) => ids,
        MessageType: { REPLY: 19, THREAD_STARTER_MESSAGE: 21, CONTEXT_MENU_COMMAND: 23 },
    });
    const Message = module.exports;
    let reads = 0;
    Message.find = async (options) => {
        reads++;
        assert.equal(options.relationLoadStrategy, "query");
        assert.deepEqual(Array.from(options.where.id).sort(), ["external", "missing"]);
        return [{ id: "external" }];
    };
    const page = [
        { id: "local" },
        { id: "a", type: 19, message_reference: { message_id: "external" } },
        { id: "b", type: 19, message_reference: { message_id: "external" } },
        { id: "c", type: 19, message_reference: { message_id: "local" } },
        { id: "d", type: 19, message_reference: { message_id: "missing" } },
    ];
    await Message.fillReplies(page);
    assert.equal(reads, 1);
    assert.equal(page[1].referenced_message, page[2].referenced_message);
    assert.equal(page[3].referenced_message, page[0]);
    assert.equal(page[4].referenced_message, null);
});
