/* SPDX-License-Identifier: AGPL-3.0-only */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

function load(file, mocks) {
    const context = { exports: {}, require: (name) => mocks[name], console: { log() {} }, clearTimeout() {} };
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
        context,
    );
    return context.exports;
}

function createFixture() {
    const created = [];
    const permissions = new Set(["VIEW_CHANNEL", "CONNECT", "STREAM"]);
    const state = { user_id: "user", channel_id: "voice", guild_id: "guild" };
    const mocks = {
        "@spacebar/database": {
            VoiceState: { findOne: async () => state },
            Member: { exists: async () => true, findOneOrFail: async () => ({}) },
            Channel: { findOne: async () => ({ id: "voice", guild_id: "guild" }) },
            Stream: {
                delete: async () => {},
                create: (value) => {
                    created.push(value);
                    throw new Error("authorized creation");
                },
            },
        },
        "@spacebar/gateway": {},
        "@spacebar/util": {
            getPermission: async () => ({ has: (name) => permissions.has(name) }),
            FederatedVoice: { relayStream: async () => false },
            Config: { get: () => ({ regions: { default: "local", available: [{ id: "local" }] } }) },
            Snowflake: { generate: () => "stream" },
        },
        "@spacebar/schemas": {},
        "./instanceOf": { check() {} },
    };
    return { ...load("src/gateway/opcodes/StreamCreate.ts", mocks), state, permissions, created };
}

test("stream creation binds authorization to the current voice channel", async () => {
    const fixture = createFixture();
    await fixture.onStreamCreate.call({ user_id: "user" }, { d: { channel_id: "foreign", guild_id: "guild", type: "guild" } });
    assert.equal(fixture.created.length, 0);
    await assert.rejects(fixture.onStreamCreate.call({ user_id: "user" }, { d: { channel_id: "voice", guild_id: "guild", type: "guild" } }), /authorized creation/);
    assert.equal(fixture.created.length, 1);
});

test("stream creation requires all current channel permissions", async () => {
    for (const denied of ["VIEW_CHANNEL", "CONNECT", "STREAM"]) {
        const fixture = createFixture();
        fixture.permissions.delete(denied);
        await fixture.onStreamCreate.call({ user_id: "user" }, { d: { channel_id: "voice", guild_id: "guild", type: "guild" } });
        assert.equal(fixture.created.length, 0);
    }
});

function identifyFixture(owner = false) {
    let claims = 0;
    let joins = 0;
    let member = true;
    const permissions = new Set(["VIEW_CHANNEL", "CONNECT", "STREAM"]);
    const socket = {
        readyState: 1,
        close(code) {
            this.closed = code;
        },
    };
    const mocks = {
        "@spacebar/database": {
            VoiceState: { findOne: async () => null },
            StreamSession: {
                findOne: async () => ({ id: "session", stream: { channel_id: "voice", owner_id: owner ? "user" : "owner" } }),
                update: async () => {
                    claims++;
                    return { affected: 1 };
                },
            },
            Channel: { findOne: async () => ({ id: "voice", guild_id: "guild" }) },
            Member: { exists: async () => member },
        },
        "@spacebar/gateway": { CLOSECODES: { Authentication_failed: 4004 } },
        "@spacebar/schemas": { validateSchema: () => ({ server_id: "123", user_id: "user", session_id: "session", token: "token" }) },
        "@spacebar/util": { getPermission: async () => ({ has: (name) => permissions.has(name) }) },
        "@spacebar/webrtc": {
            mediaServer: {
                join: async () => {
                    joins++;
                    throw new Error("stop after join");
                },
            },
        },
        "@spacebarchat/spacebar-webrtc-types": {},
        "./Video": {},
        "./Speaking": {},
        "../util/VoiceSessions": { VoiceSessions: { register: async () => {} } },
        "../util/DaveIdentity": { daveIdOf: async (user_id) => user_id },
    };
    return {
        ...load("src/webrtc/opcodes/Identify.ts", mocks),
        socket,
        permissions,
        revokeMembership: () => {
            member = false;
        },
        counts: () => ({ claims, joins }),
    };
}

test("stream tokens cannot redeem after membership or permissions are revoked", async () => {
    for (const denied of ["member", "VIEW_CHANNEL", "CONNECT"]) {
        const fixture = identifyFixture();
        if (denied === "member") fixture.revokeMembership();
        else fixture.permissions.delete(denied);
        await fixture.onIdentify.call(fixture.socket, { d: {} });
        assert.equal(fixture.socket.closed, 4004);
        assert.deepEqual(fixture.counts(), { claims: 0, joins: 0 });
    }
    const owner = identifyFixture(true);
    owner.permissions.delete("STREAM");
    await owner.onIdentify.call(owner.socket, { d: {} });
    assert.deepEqual(owner.counts(), { claims: 0, joins: 0 });
});

test("closed stream sockets cannot claim tokens or join media rooms", async () => {
    const closed = identifyFixture();
    closed.socket.readyState = 3;
    await closed.onIdentify.call(closed.socket, { d: {} });
    assert.deepEqual(closed.counts(), { claims: 0, joins: 0 });
    const viewer = identifyFixture();
    await viewer.onIdentify.call(viewer.socket, { d: {} });
    assert.deepEqual(viewer.counts(), { claims: 1, joins: 1 });
});

test("stream watch refuses token issuance without current membership and connect permission", async () => {
    for (const denied of ["member", "VIEW_CHANNEL", "CONNECT"]) {
        let issued = 0;
        const events = [];
        const mocks = {
            typeorm: { Not: (value) => value },
            "@spacebar/database": {
                Stream: { findOne: async () => ({ id: "123", owner_id: "owner", channel_id: "voice", channel: { guild_id: "guild" } }) },
                Member: { exists: async () => denied !== "member" },
                StreamSession: {
                    create: () => {
                        issued++;
                    },
                },
            },
            "@spacebar/gateway": { parseStreamKey: () => ({ type: "guild", channelId: "voice", guildId: "guild", userId: "owner" }) },
            "@spacebar/util": {
                getPermission: async () => ({ has: (name) => name !== denied }),
                emitEvent: async (event) => events.push(event),
                FederatedVoice: { relayStream: async () => false },
            },
            "@spacebar/schemas": {},
            "./instanceOf": { check() {} },
        };
        const handler = load("src/gateway/opcodes/StreamWatch.ts", mocks);
        await handler.onStreamWatch.call({ user_id: "viewer" }, { d: { stream_key: "key" } });
        assert.equal(issued, 0);
        assert.equal(events[0].data.reason, "unauthorized");
    }
});
