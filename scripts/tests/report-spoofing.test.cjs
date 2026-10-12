const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

const load = (file, imports) => {
    const module = { exports: {} };
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync(file, "utf8"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
        }).outputText,
        { module, exports: module.exports, require: (name) => imports[name] ?? require(name), Buffer, Date, JSON, Array, Promise },
    );
    return module.exports;
};

class HTTPError extends Error {
    constructor(message, code) {
        super(message);
        this.code = code;
    }
}

const harness = ({ members = [], existing = null, viewable = ["200"] } = {}) => {
    const saved = [];
    const { createReport } = load("src/api/util/utility/reports.ts", {
        "lambert-server/HTTPError": { HTTPError },
        typeorm: { In: (v) => v, MoreThan: (v) => v, LessThan: (v) => v, IsNull: () => null },
        "@spacebar/database": {
            Report: {
                count: async () => 0,
                findOne: async () => existing,
                create: (data) => ({
                    ...data,
                    async save() {
                        saved.push(this);
                        return this;
                    },
                }),
            },
            Message: {
                findOne: async ({ where }) =>
                    where.id === "300" && where.channel_id === "200"
                        ? { id: "300", channel_id: "200", guild_id: "100", author_id: "11", content: "hi", attachments: [], embeds: [], timestamp: new Date(0) }
                        : null,
                find: async () => [],
            },
            Member: { exists: async ({ where }) => members.includes(`${where.id}@${where.guild_id}`) },
            Guild: { findOne: async ({ where }) => (where.id === "100" ? { id: "100", name: "the server", owner_id: "14" } : null) },
            GuildScheduledEvent: { findOne: async ({ where }) => (where.id === "700" ? { id: "700", guild_id: "100", channel_id: null, creator_id: "15", name: "party" } : null) },
            StageInstance: { findOne: async ({ where }) => (where.id === "800" ? { id: "800", guild_id: "100", channel_id: "200", topic: "talk" } : null) },
            Application: { findOne: async ({ where }) => (where.id === "900" ? { id: "900", name: "bot", owner_id: "16" } : null) },
            User: {
                findOne: async ({ where }) => (["11", "12"].includes(where.id) ? { id: where.id, username: where.id, profile_widgets: [] } : null),
                exists: async () => true,
            },
            E2eeDevice: {},
            Channel: {},
        },
        "@spacebar/schemas": {
            ReportMenuType: {
                MESSAGE: "message",
                FIRST_DM: "first_dm",
                USER: "user",
                GUILD: "guild",
                GUILD_DISCOVERY: "guild_discovery",
                GUILD_DIRECTORY_ENTRY: "guild_directory_entry",
                GUILD_SCHEDULED_EVENT: "guild_scheduled_event",
                STAGE_CHANNEL: "stage_channel",
                APPLICATION: "application",
                WIDGET: "widget",
            },
            ChannelType: {},
        },
        "@spacebar/util": {
            DiscordApiErrors: {
                UNKNOWN_MESSAGE: new Error("unknown message"),
                UNKNOWN_GUILD: new Error("unknown guild"),
                UNKNOWN_USER: new Error("unknown user"),
                UNKNOWN_CHANNEL: new Error("unknown channel"),
                UNKNOWN_APPLICATION: new Error("unknown application"),
            },
            getPermission: async (user, guild, channel) => ({ has: () => viewable.includes(channel) }),
        },
        "../handlers/ApplicationWidgets": { snapshotWidget: async () => null },
        "./e2ee": { verifyEd25519: () => false },
        "./reportMenus": { getReportingMenu: () => ({ nodes: {} }) },
        "./instanceAutomod": { automodVerifiedReport: async () => undefined },
    });
    const report = (type, body, reporter = "13") => createReport(type, { name: type, breadcrumbs: [], ...body }, reporter, { root_node_id: 0, nodes: {} });
    return { report, saved };
};

test("a user report can't attach a server, channel or message the reporter made up", async () => {
    const { report } = harness();
    const saved = await report("user", { reported_user_id: "11", guild_id: "100", channel_id: "200", message_id: "300", application_id: "900" });
    assert.equal(saved.reported_user_id, "11");
    assert.equal(saved.guild_id, undefined);
    assert.equal(saved.channel_id, undefined);
    assert.equal(saved.message_id, undefined);
    assert.equal(saved.application_id, undefined);
});

test("a user report keeps the server only when both people are in it", async () => {
    const { report } = harness({ members: ["13@100", "11@100"] });
    assert.equal((await report("user", { reported_user_id: "11", guild_id: "100" })).guild_id, "100");
});

test("server, event and app reports blame the real owner, not the claimed user", async () => {
    const { report } = harness({ members: ["13@100"] });
    assert.equal((await report("guild", { guild_id: "100", reported_user_id: "12" })).reported_user_id, "14");
    assert.equal((await report("guild_scheduled_event", { guild_id: "100", guild_scheduled_event_id: "700", reported_user_id: "12" })).reported_user_id, "15");
    assert.equal((await report("application", { application_id: "900", reported_user_id: "12" })).reported_user_id, "16");
});

test("ids that don't exist or don't belong together are refused", async () => {
    const { report, saved } = harness({ members: ["13@100"] });
    await assert.rejects(report("message", { channel_id: "201", message_id: "300" }));
    await assert.rejects(report("message", { message_id: "300" }));
    await assert.rejects(report("guild", { guild_id: "101" }));
    await assert.rejects(report("guild_scheduled_event", { guild_id: "101", guild_scheduled_event_id: "700" }));
    await assert.rejects(report("stage_channel", { guild_id: "100", channel_id: "201", stage_instance_id: "800" }));
    await assert.rejects(report("application", { application_id: "901" }));
    await assert.rejects(report("user", { reported_user_id: "17" }));
    assert.equal(saved.length, 0);
});

test("a message report takes its author, server and channel from the stored message", async () => {
    const { report } = harness();
    const saved = await report("message", { channel_id: "200", message_id: "300", guild_id: "999", reported_user_id: "12" });
    assert.equal(saved.reported_user_id, "11");
    assert.equal(saved.guild_id, "100");
});

test("a stage report names a speaker only when they're in the server", async () => {
    const { report } = harness({ members: ["12@100"] });
    assert.equal((await report("stage_channel", { guild_id: "100", channel_id: "200", stage_instance_id: "800", reported_user_id: "12" })).reported_user_id, "12");
    assert.equal((await report("stage_channel", { guild_id: "100", channel_id: "200", stage_instance_id: "800", reported_user_id: "11" })).reported_user_id, undefined);
});

test("reporting the same thing again updates the open report instead of adding another", async () => {
    const existing = {
        id: "1",
        reason: "old",
        async save() {
            return this;
        },
    };
    const { report, saved } = harness({ existing });
    const result = await report("message", { channel_id: "200", message_id: "300", breadcrumbs: [] });
    assert.equal(result, existing);
    assert.equal(saved.length, 0);
});
