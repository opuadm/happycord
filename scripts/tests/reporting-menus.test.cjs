const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

function load(relative, imports = {}) {
    const source = fs.readFileSync(path.join(__dirname, "../../", relative), "utf8");
    const module = { exports: {} };
    vm.runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
        }).outputText,
        {
            module,
            exports: module.exports,
            require: (id) => {
                if (id in imports) return imports[id];
                throw new Error(`Unexpected dependency ${id}`);
            },
            process: { env: { LOG_ROUTES: "false" } },
            console,
            Date,
        },
    );
    return module.exports;
}

const schemas = load("src/schemas/api/reports/ReportMenu.ts");
const errors = {
    FieldErrors: (fields) => Object.assign(new Error("Invalid reporting menu"), { fields }),
};
const menus = load("src/api/util/utility/reportMenus.ts", {
    "@spacebar/schemas": schemas,
    "@spacebar/util": errors,
});
class HTTPError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

function routes() {
    const handlers = new Map();
    const calls = [];
    const router = {};
    for (const method of ["get", "post"]) router[method] = (url, ...middleware) => handlers.set(`${method} ${url}`, middleware.at(-1));
    load("src/api/routes/reporting/index.ts", {
        express: { Router: () => router },
        "lambert-server/HTTPError": { HTTPError },
        "@spacebar/api/middlewares": { route: () => () => {} },
        "@spacebar/schemas": schemas,
        "@spacebar/util": errors,
        "@spacebar/api/util": {
            createReport: async (...args) => {
                calls.push(args);
                return { id: "report-1" };
            },
        },
        "../../util/utility/reportMenus": menus,
    });
    return { handlers, calls };
}

for (const type of Object.values(schemas.ReportMenuType)) {
    test(`serve and accept a locally authored ${type} reporting menu without files`, async () => {
        const { handlers, calls } = routes();
        let menu, result;
        handlers.get(`get /menu/${type}`)(
            {},
            {
                json: (value) => {
                    menu = value;
                },
            },
        );
        assert.equal(menu.name, type);
        assert.equal(menu.nodes[menu.root_node_id].children.length, 6);
        assert.equal(menu.postback_url, `/api/v9/reporting/${type}`);
        const reason = menu.nodes[menu.root_node_id].children[0][1];
        const body = {
            name: type,
            version: menu.version,
            variant: menu.variant,
            breadcrumbs: [menu.root_node_id, reason],
            language: "en",
            guild_id: "100",
            channel_id: "200",
            message_id: "300",
            stage_instance_id: "400",
            guild_scheduled_event_id: "500",
            user_id: "600",
            application_id: "700",
            widget_id: "widget",
        };
        await handlers.get(`post /${type}`)(
            { user_id: "reporter", body },
            {
                json: (value) => {
                    result = value;
                },
            },
        );
        assert.equal(result.report_id, "report-1");
        assert.equal(calls.length, 1);
        assert.equal(calls[0][2], "reporter");
    });
}

test("reject stale menus and forged, empty, repeated or non-submit breadcrumb paths before storing", async () => {
    const { handlers, calls } = routes();
    const menu = menus.getReportingMenu("user");
    const body = {
        name: "user",
        version: menu.version,
        variant: menu.variant,
        language: "en",
        breadcrumbs: [1000, 1010],
        user_id: "600",
    };
    const attempts = [
        { version: "1.0" },
        { variant: "1" },
        { name: "message" },
        { breadcrumbs: [] },
        { breadcrumbs: [1010] },
        { breadcrumbs: [999, 1010] },
        { breadcrumbs: [1000, 1900] },
        { breadcrumbs: [1000, 1901] },
        { breadcrumbs: [1000, 1000] },
        { breadcrumbs: [1000, 1010, 1010] },
        { breadcrumbs: [1000, "1010"] },
    ];
    for (const attempt of attempts) await assert.rejects(handlers.get("post /user")({ user_id: "reporter", body: { ...body, ...attempt } }, { json() {} }));
    assert.equal(calls.length, 0);
});

test("required target fields remain enforced", async () => {
    const { handlers, calls } = routes();
    const menu = menus.getReportingMenu("message");
    await assert.rejects(
        handlers.get("post /message")(
            {
                user_id: "reporter",
                body: {
                    name: "message",
                    version: menu.version,
                    variant: menu.variant,
                    language: "en",
                    breadcrumbs: [1000, 1010],
                },
            },
            { json() {} },
        ),
    );
    assert.equal(calls.length, 0);
});

function reportUtility({ view = true, author = "target" } = {}) {
    const saved = [];
    const entities = {
        Report: {
            count: async () => 0,
            create: (data) => ({
                ...data,
                save: async function () {
                    saved.push(this);
                    return this;
                },
            }),
        },
        Message: {
            findOne: async () => ({
                id: "300",
                channel_id: "200",
                guild_id: "100",
                author_id: author,
                content: "reported content",
                attachments: [],
                timestamp: new Date(0),
            }),
        },
        User: { exists: async () => true },
        Channel: {},
        Guild: {},
    };
    const utility = load("src/api/util/utility/reports.ts", {
        "@spacebar/database": entities,
        "@spacebar/schemas": schemas,
        "lambert-server/HTTPError": { HTTPError },
        typeorm: { In: (value) => value, MoreThan: (value) => value },
        "@spacebar/util": {
            DiscordApiErrors: { UNKNOWN_MESSAGE: new Error("Unknown message") },
            getPermission: async () => ({ has: () => view }),
        },
        "../handlers/ApplicationWidgets": {},
        "node:crypto": require("node:crypto"),
        "./e2ee": { verifyEd25519: () => false },
        "./reportMenus": menus,
    });
    return { ...utility, saved };
}

test("persist a reported message reason and snapshot without changing actor authorization", async () => {
    const utility = reportUtility();
    const result = await utility.createReport(
        "message",
        { guild_id: "100", channel_id: "200", message_id: "300", breadcrumbs: [1000, 1010] },
        "reporter",
        menus.getReportingMenu("message"),
    );
    assert.equal(result.reason, "Hateful language");
    assert.equal(result.reporter_id, "reporter");
    assert.equal(result.reported_user_id, "target");
    assert.equal(result.snapshot.content, "reported content");
    assert.equal(utility.saved.length, 1);
});

test("deny inaccessible messages and self reports before saving", async () => {
    for (const options of [{ view: false }, { author: "reporter" }]) {
        const utility = reportUtility(options);
        await assert.rejects(utility.createReport("message", { channel_id: "200", message_id: "300", breadcrumbs: [1000, 1010] }, "reporter", menus.getReportingMenu("message")));
        assert.equal(utility.saved.length, 0);
    }
});

test("preserve historical persisted reasons and never reinterpret deleted menu IDs", () => {
    const utility = reportUtility();
    assert.equal(
        utility.reportReason({
            type: "message",
            reason: "Previously saved reason",
            breadcrumbs: [7, 98],
        }),
        "Previously saved reason",
    );
    assert.equal(utility.reportReason({ type: "message", reason: "", breadcrumbs: [7, 98] }), "Report submitted with an earlier menu");
    assert.equal(utility.reportReason({ type: "message", reason: "", breadcrumbs: [1000, 1010] }), "Hateful language");
});
