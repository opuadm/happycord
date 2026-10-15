const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

const { federationTrustDecision, FederationRequestError } = require("../../src/util/util/federation/Protocol.ts");
const { describeHostAnswer, describeHostFailure } = require("../../src/util/util/federation/HostErrors.ts");
const { ApiError } = require("../../src/util/util/ApiError.ts");
const PublicFetchErrors = require("../../src/util/util/networking/PublicFetchError.ts");
const { PublicFetchError, publicFetchFailure } = PublicFetchErrors;
const join = require("../../client/plugins/fosscordFederation/join.ts");

const key = "f0jm9Szfa52pkT0nWkeZK4D1wa3NUZ9hceWaFQLZYrk";
const entry = (id, overrides = {}) => ({
    id,
    name: id,
    description: "",
    icon_url: null,
    url: `https://${id}`,
    source_url: null,
    public_key: key,
    protocol: 2,
    registration: "open",
    state: "active",
    listed_at: null,
    ...overrides,
});
const base = {
    ownId: "home.example",
    enabled: true,
    document: {
        min_protocol: 1,
        blocked: { instances: [], guilds: [], users: [] },
        instances: [entry("active.example"), entry("listed.example", { state: "listed", public_key: null, protocol: null }), entry("old.example", { protocol: 1 })],
    },
    local: { instances: [], guilds: [], users: [] },
    allowUnlistedPeers: false,
    peers: [],
};

test("the trust decision names the reason an instance doesn't federate", () => {
    assert.deepEqual(federationTrustDecision({ ...base, id: "active.example" }).trust, { source: "registry", public_key: key });
    const listed = federationTrustDecision({ ...base, id: "listed.example" });
    assert.equal(listed.reason, "inactive");
    assert.match(listed.detail, /lists listed\.example as listed, and only active instances federate/);
    assert.equal(federationTrustDecision({ ...base, id: "old.example" }).reason, "old_protocol");
    const unlisted = federationTrustDecision({ ...base, id: "new.example" });
    assert.equal(unlisted.reason, "unlisted");
    assert.match(unlisted.detail, /isn't in home\.example's copy of the registry list/);
    assert.match(unlisted.detail, /every 5 minutes/);
    assert.equal(federationTrustDecision({ ...base, id: "active.example", enabled: false }).reason, "disabled");
    assert.equal(federationTrustDecision({ ...base, id: "active.example", document: null }).reason, "no_registry");
    assert.equal(federationTrustDecision({ ...base, id: "active.example", local: { instances: ["active.example"], guilds: [], users: [] } }).reason, "blocked");
    const peer = { ...base, id: "peer.example", allowUnlistedPeers: true, peers: ["peer.example"] };
    assert.equal(federationTrustDecision({ ...peer, peerProtocol: null }).reason, "peer_unreadable");
    assert.equal(federationTrustDecision({ ...peer, peerProtocol: 1 }).reason, "old_protocol");
    assert.deepEqual(federationTrustDecision({ ...peer, peerProtocol: 2 }).trust, { source: "peer", public_key: null });
    for (const id of ["listed.example", "old.example", "new.example"]) assert.doesNotMatch(federationTrustDecision({ ...base, id }).detail, /[–—]/);
});

test("transport failures to a host become specific errors", () => {
    const timeout = describeHostFailure("host.example", new PublicFetchError("timeout", "host.example didn't answer within 20 seconds"));
    assert.ok(timeout instanceof FederationRequestError);
    assert.equal(timeout.code, "host_timeout");
    assert.equal(timeout.status, 504);
    const refused = describeHostFailure("host.example", Object.assign(new Error("connect ECONNREFUSED 1.2.3.4:443"), { code: "ECONNREFUSED" }));
    assert.equal(refused.code, "host_unreachable");
    assert.equal(refused.status, 502);
    assert.match(refused.message, /Couldn't reach host\.example/);
    assert.equal(describeHostFailure("host.example", new Error("The outbound proxy could not reach the host (code 4)")).code, "host_unreachable");
    assert.equal(describeHostFailure("host.example", new Error("The outbound proxy refused the connection")).code, "proxy_error");
    const passed = new FederationRequestError("rate_limited", "Too many requests", 429);
    assert.equal(describeHostFailure("host.example", passed), passed);
});

test("host answers keep their meaning without leaking 401 or HTML to the client", () => {
    const html = describeHostAnswer("host.example", 502, { raw: "<html>Bad gateway</html>" }, "home.example");
    assert.equal(html.code, "host_bad_response");
    assert.equal(html.status, 502);
    const old = describeHostAnswer("host.example", 403, { code: "not_federated", error: "This instance doesn't federate with the sender" }, "home.example");
    assert.equal(old.code, "unknown_sender");
    assert.match(old.message, /host\.example doesn't accept requests from home\.example yet/);
    assert.match(old.message, /every 5 minutes/);
    const reason = describeHostAnswer(
        "host.example",
        403,
        { code: "not_federated", error: "The registry lists home.example as listed, and only active instances federate." },
        "home.example",
    );
    assert.equal(reason.code, "not_federated");
    assert.match(reason.message, /as listed/);
    assert.equal(describeHostAnswer("host.example", 401, { code: "bad_signature", error: "The signature does not verify" }, "home.example").status, 403);
    const banned = describeHostAnswer("host.example", 400, { code: 40007, message: "The user is banned from this guild" }, "home.example");
    assert.ok(banned instanceof ApiError);
    assert.equal(banned.code, 40007);
    const staff = describeHostAnswer("host.example", 401, { code: 401, message: "Only intended for the staff of this instance." }, "home.example");
    assert.equal(staff.httpStatus, 403);
    const crash = describeHostAnswer("host.example", 500, { code: "internal", error: "Internal error" }, "home.example");
    assert.equal(crash.status, 502);
    assert.equal(crash.message, "Internal error");
    assert.equal(describeHostAnswer("host.example", 503, null, "home.example").code, "host_error");
});

test("public fetch failures are classified", () => {
    assert.equal(publicFetchFailure(new PublicFetchError("timeout", "x")), "timeout");
    assert.equal(publicFetchFailure(Object.assign(new Error("getaddrinfo ENOTFOUND x"), { code: "ENOTFOUND" })), "dns");
    assert.equal(publicFetchFailure(new Error("Connection closed early")), "unreachable");
    assert.equal(publicFetchFailure(new Error("unable to verify the first certificate")), "tls");
    assert.equal(publicFetchFailure(new Error("something else")), "other");
});

test("a proxied fetch that never settles still rejects with a timeout at its deadline", async () => {
    const module = { exports: {} };
    const imports = {
        "node:dns/promises": { lookup: async () => [{ address: "93.184.216.34", family: 4 }] },
        "node:net": require("node:net"),
        "node:http": { request: () => assert.fail("direct request") },
        "node:https": { request: () => assert.fail("direct request") },
        "../Config": { Config: { get: () => ({ security: { allowPrivateNetworkRequests: false } }) } },
        "./SocksTransport": { outboundProxy: () => ({ host: "127.0.0.1", port: 1 }), socksExchange: () => new Promise(() => {}), socksTunnel: () => new Promise(() => {}) },
        "./PublicFetchError": PublicFetchErrors,
    };
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync("src/util/util/networking/PublicNetwork.ts", "utf8"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText,
        {
            module,
            exports: module.exports,
            require: (name) => {
                assert.ok(name in imports, name);
                return imports[name];
            },
            URL,
            Response,
            Headers,
            Buffer,
            Uint8Array,
            AbortController,
            AbortSignal,
            setTimeout,
            clearTimeout,
        },
    );
    const started = Date.now();
    await assert.rejects(module.exports.fetchPublicUrl("https://host.example/federation/v2/join", { method: "POST", body: "{}" }, 0, { timeoutMs: 80 }), (error) => {
        assert.equal(error.kind, "timeout");
        assert.match(error.message, /host\.example didn't answer within/);
        return true;
    });
    assert.ok(Date.now() - started < 1000);
});

const fakeClient = (overrides = {}) => {
    const guilds = new Set();
    const calls = { navigate: [], received: [] };
    const deps = {
        post: async () => ({ body: {} }),
        hasGuild: (id) => guilds.has(id),
        receiveGuild: (guild) => {
            calls.received.push(guild.id);
            guilds.add(guild.id);
        },
        navigate: (guildId, channelId) => calls.navigate.push([guildId, channelId]),
        sleep: () => new Promise((resolve) => setImmediate(resolve)),
        waitMs: 300,
        ...overrides,
    };
    return { deps, guilds, calls };
};

test("the join button stops waiting when the instance never answers", async () => {
    const { deps, calls } = fakeClient({ post: () => new Promise(() => {}), timeoutMs: 50 });
    const result = await join.joinRemote(deps);
    assert.equal(result.kind, "failed");
    assert.equal(result.message, join.TIMEOUT_MESSAGE);
    assert.equal(calls.navigate.length, 0);
});

test("the join button shows the instance's message and hides bare status texts", async () => {
    const failing = (error) => fakeClient({ post: () => Promise.reject(error) }).deps;
    assert.equal(
        (await join.joinRemote(failing({ body: { code: 0, message: "Couldn't reach host.example. It may be down." } }))).message,
        "Couldn't reach host.example. It may be down.",
    );
    assert.equal((await join.joinRemote(failing({ body: { code: 0, message: "500: Internal Server Error" } }))).message, "Couldn't join this server. Try again.");
    assert.equal((await join.joinRemote(failing({ timeout: 40000, message: "Timeout of 40000ms exceeded" }))).message, join.TIMEOUT_MESSAGE);
});

test("a join waiting for approval says so instead of opening a server", async () => {
    const { deps, calls } = fakeClient({ post: async () => ({ body: { guild: { id: "1" }, meowcord_pending: true } }) });
    const result = await join.joinRemote(deps);
    assert.equal(result.kind, "pending");
    assert.equal(calls.navigate.length, 0);
});

test("without GUILD_CREATE from the gateway the client loads the server from the join answer and opens it", async () => {
    const { deps, calls } = fakeClient({
        post: async () => ({ body: { guild_id: "10", channel: { id: "11" }, meowcord_guild: { id: "10", channels: [] } } }),
    });
    const result = await join.joinRemote(deps);
    assert.deepEqual(result, { kind: "opened", guildId: "10" });
    assert.deepEqual(calls.received, ["10"]);
    assert.deepEqual(calls.navigate, [["10", "11"]]);
});

test("when GUILD_CREATE arrives the answer's copy isn't injected", async () => {
    const client = fakeClient({ post: async () => ({ body: { guild_id: "10", meowcord_guild: { id: "10" } } }) });
    client.guilds.add("10");
    const result = await join.joinRemote(client.deps);
    assert.equal(result.kind, "opened");
    assert.deepEqual(client.calls.received, []);
});

test("a server that never loads says so instead of opening an empty skeleton", async () => {
    const { deps, calls } = fakeClient({ post: async () => ({ body: { guild_id: "10" } }) });
    const result = await join.joinRemote(deps);
    assert.deepEqual(result, { kind: "unloaded", message: join.UNLOADED_MESSAGE });
    assert.deepEqual(calls.navigate, []);
});

test("a server copy with another id or a failing gateway dispatcher is not trusted", async () => {
    const mismatched = fakeClient();
    assert.equal(await join.ensureGuild("10", { id: "20" }, mismatched.deps), false);
    assert.deepEqual(mismatched.calls.received, []);
    const broken = fakeClient({
        receiveGuild: () => {
            throw new Error("The gateway isn't connected");
        },
    });
    assert.equal(await join.ensureGuild("10", { id: "10" }, broken.deps), false);
});
