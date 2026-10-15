const assert = require("node:assert/strict");
const { test } = require("node:test");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

function harness({ tokenSession = "auth-A", tokenUser = "owner", revokedToken = false, storedSession = true, legacyToken = false, lookup } = {}) {
    const previous = {
        user_id: "owner",
        session_id: "gateway-A",
        session: {
            session_id: "auth-A",
            user_id: "owner",
            status: "online",
            activities: [],
            client_status: {},
        },
        accessToken: "token-A",
        sequence: 4,
        resumeBuffer: [{ op: 0, t: "MESSAGE_CREATE", s: 3, d: { content: "queued event" } }],
        replayBuffer: [],
        events: { "auth-A": () => {} },
        permissions: {},
        member_lists: {},
        listenerCleanup: async () => {},
    };
    const resumableSockets = new Map([[previous.session_id, previous]]);
    const sent = [];
    const checked = [];
    let updates = 0;
    const module = { exports: {} };
    const mocks = {
        "@spacebar/database": {
            Session: {
                findOne: async (options) => {
                    checked.push(options);
                    return lookup ? lookup(options) : storedSession ? { ...previous.session } : null;
                },
                update: async () => {
                    updates++;
                },
            },
        },
        "@spacebar/gateway": {
            resumableSockets,
            OPCODES: { Dispatch: 0, Invalid_Session: 9 },
            holdForResume() {},
            Send: async (_, payload) => {
                sent.push(payload);
            },
        },
        "@spacebar/util": {
            checkToken: async () => {
                if (revokedToken) throw new Error("Session revoked");
                return {
                    user: { id: tokenUser },
                    session: legacyToken ? undefined : { session_id: tokenSession },
                    decoded: legacyToken ? {} : { did: tokenSession },
                };
            },
            broadcastPresence: async () => {},
        },
        "../util/Constants": { CLOSECODES: { Already_authenticated: 4005 } },
        "./LazyRequest": { resubscribeMemberLists() {} },
    };
    const filename = path.join(__dirname, "../../src/gateway/opcodes/Resume.ts");
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync(filename, "utf8"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText,
        {
            module,
            exports: module.exports,
            require: (name) => mocks[name],
            clearTimeout,
            console: { log() {} },
        },
        { filename },
    );
    const socket = Object.assign(new EventEmitter(), { OPEN: 1, readyState: 1, close() {} });
    return {
        previous,
        resumableSockets,
        sent,
        checked,
        socket,
        updates: () => updates,
        resume: (token = "token-A") => module.exports.onResume.call(socket, { d: { token, session_id: "gateway-A", seq: 2 } }),
    };
}

const assertDenied = (h) => {
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].op, 9);
    assert.equal(h.sent[0].d, false);
    assert.equal(h.socket.user_id, undefined);
    assert.equal(h.previous.resumedBy, undefined);
    assert.equal(h.updates(), 0);
};

test("a different auth session cannot inherit a same-user gateway session and its revocation subscription", async () => {
    const h = harness({ tokenSession: "auth-B" });
    await h.resume("token-B");
    assertDenied(h);
    assert.equal(h.resumableSockets.get("gateway-A"), h.previous);
});

test("same-session refreshed tokens resume, replay queued events and preserve the revocation subscription", async () => {
    const h = harness();
    await h.resume("refreshed-token-A");
    assert.equal(h.socket.session.session_id, "auth-A");
    assert.equal(h.socket.accessToken, "refreshed-token-A");
    assert.equal(h.socket.events, h.previous.events);
    assert.equal(h.sent[0].t, "MESSAGE_CREATE");
    assert.equal(h.sent[1].t, "RESUMED");
    assert.equal(h.previous.resumedBy, h.socket);
    assert.equal(h.resumableSockets.has("gateway-A"), false);
});

test("revoked tokens and deleted original auth sessions cannot resume", async () => {
    for (const options of [{ revokedToken: true }, { storedSession: false }, { storedSession: false, legacyToken: true }]) {
        const h = harness(options);
        await h.resume();
        assertDenied(h);
    }
});

test("legacy credentials can resume only their original still-active auth session", async () => {
    const valid = harness({ legacyToken: true });
    await valid.resume("Bearer token-A");
    assert.equal(valid.sent.at(-1).t, "RESUMED");
    const different = harness({ legacyToken: true });
    await different.resume("other-legacy-token");
    assertDenied(different);
});

test("different users cannot resume and a socket closed during validation cannot acquire the session", async () => {
    const other = harness({ tokenUser: "other" });
    await other.resume();
    assertDenied(other);
    const closed = harness();
    closed.socket.readyState = 3;
    await closed.resume();
    assert.equal(closed.socket.user_id, undefined);
    assert.equal(closed.previous.resumedBy, undefined);
});

test("two concurrent resumes cannot take the same buffered session", async () => {
    let release;
    const wait = new Promise((resolve) => {
        release = resolve;
    });
    const h = harness({
        lookup: async () => {
            await wait;
            return { session_id: "auth-A", user_id: "owner", status: "online" };
        },
    });
    const first = h.resume();
    const second = h.resume();
    release();
    await Promise.all([first, second]);
    assert.equal(h.sent.filter((event) => event.t === "RESUMED").length, 1);
    assert.equal(h.sent.filter((event) => event.op === 9).length, 1);
});

test("legacy gateway token refresh preserves the existing auth session and yields a normally valid API token", async () => {
    const crypto = require("node:crypto");
    const jwt = require("jsonwebtoken");
    const keys = crypto.generateKeyPairSync("ec", { namedCurve: "secp521r1" });
    const session = { session_id: "auth-A", user_id: "owner", last_seen: new Date() };
    let sessionCreations = 0;
    const user = { id: "owner", data: { valid_tokens_since: new Date(0) } };
    const tokenModule = { exports: {} };
    const mocks = {
        "@spacebar/database": {
            User: { findOne: async () => user, findOneOrFail: async () => user },
            Session: {
                findOne: async ({ where }) => (where.session_id === session.session_id && where.user_id === user.id ? session : null),
                create: () => {
                    sessionCreations++;
                    throw new Error("Refresh must preserve the original auth session");
                },
            },
            InstanceBan: { hasInstanceBans: async () => false },
        },
        "@spacebar/extensions": {},
        "@spacebar/schemas": require("../../src/schemas/responses/AccountStandingResponse.ts"),
        "lambert-server/HTTPError": { HTTPError: class extends Error {} },
        "./Config": { Config: { get: () => ({ security: { jwtSecret: null } }) } },
        "@spacebar/util": { OrmUtils: { keysToObject: () => ({}) } },
        "@spacebar/util/util/ProcessLifecycle": {},
        "./StaffRoles": { isStaffAccount: () => false, loadStaffRoles: async () => ({}) },
    };
    const filename = path.join(__dirname, "../../src/util/util/Token.ts");
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync(filename, "utf8"), {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2022,
                esModuleInterop: true,
            },
        }).outputText,
        {
            module: tokenModule,
            exports: tokenModule.exports,
            require: (name) => (Object.hasOwn(mocks, name) ? mocks[name] : require(name)),
            Buffer,
            Date,
            console: { log() {}, error() {} },
            process: { env: {} },
        },
        { filename },
    );
    const tokenHelpers = tokenModule.exports;
    Object.defineProperty(tokenHelpers.JwtKeypairManager, "keypair", {
        get: () => ({
            privateKey: keys.privateKey,
            publicKey: keys.publicKey,
            fingerprint: "synthetic-test-key",
        }),
    });
    const identify = fs.readFileSync(path.join(__dirname, "../../src/gateway/opcodes/Identify.ts"), "utf8");
    const sourceFile = ts.createSourceFile("Identify.ts", identify, ts.ScriptTarget.ES2022, true);
    let refresh;
    const visit = (node) => {
        if (ts.isIfStatement(node) && node.getText(sourceFile).includes("d.auth_token") && node.expression.getText(sourceFile).includes("AUTH_TOKEN_REFRESH"))
            refresh = node.getText(sourceFile);
        else ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    assert.ok(refresh, "Run the actual gateway refresh branch");
    const socket = { user_id: user.id, capabilities: { has: () => true } };
    const d = {};
    const context = {
        session,
        d,
        tokenData: { tokenVersion: 2 },
        CurrentTokenFormatVersion: tokenHelpers.CurrentTokenFormatVersion,
        Capabilities: { FLAGS: { AUTH_TOKEN_REFRESH: 1 } },
        generateToken: tokenHelpers.generateToken,
    };
    const executable = ts.transpileModule(`(async function () { ${refresh} })`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const execute = vm.runInNewContext(executable, context);
    await execute.call(socket);
    assert.equal(sessionCreations, 0);
    assert.equal(socket.accessToken, d.auth_token);
    assert.equal(jwt.verify(d.auth_token, keys.publicKey).did, session.session_id);
    const validated = await tokenHelpers.checkToken(d.auth_token);
    assert.equal(validated.user.id, user.id);
    assert.equal(validated.session.session_id, session.session_id);
});
