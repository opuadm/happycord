import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
    adminChatConfig,
    chatContacts,
    chatState,
    closeAdminChat,
    connectChatAccount,
    disconnectChatAccount,
    finishChatAccountMfa,
    openAdminChat,
    secretChatConfig,
} from "../src/admin/chat.js";
import { handleAdmin } from "../src/admin/pages.js";
import { checkAnnouncePayload, cleanContacts, storeContacts } from "../src/announce.js";
import { randomBase64Url, sha256Hex } from "../src/crypto.js";
import { buildContent } from "../src/registry.js";
import { fakeD1 } from "./d1.js";
import { announcePayload } from "./helpers.js";

const ORIGIN = "https://hub.meow.example.com";
const TOKEN = "test-token";
const realFetch = globalThis.fetch;

function addInstance(env, id, status = "approved") {
    const now = new Date().toISOString();
    env.DB.sqlite
        .query("INSERT INTO instances (id, status, url, public_key, protocol, federation_enabled, created_at, updated_at) VALUES (?, ?, ?, 'key', 2, 1, ?, ?)")
        .run(id, status, `https://${id}`, now, now);
}

function fakeMeowcord({ users, refuseAdd = new Set() }) {
    const state = { channels: new Map(), requests: [], nextId: 900 };
    const me = "1";
    globalThis.fetch = async (input, init = {}) => {
        const url = new URL(input);
        const method = init.method ?? "GET";
        state.requests.push(`${method} ${url.pathname}`);
        expect(url.origin).toBe(ORIGIN);
        expect(init.headers.authorization).toBe(TOKEN);
        const path = url.pathname.replace(/^\/api\/v9/, "");
        const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
        const others = (channel) => [...channel.members].filter((id) => id !== me).map((id) => ({ id }));
        if (method === "GET" && path === "/users/@me") return json({ id: me });
        if (method === "GET" && path === "/federation/users/lookup") {
            const id = users[url.searchParams.get("handle")];
            return id ? json({ id }) : json({ message: "Unknown User", code: 10013 }, 404);
        }
        if (method === "POST" && path === "/users/@me/channels") {
            const body = JSON.parse(init.body);
            const id = String(state.nextId++);
            state.channels.set(id, { id, name: body.name, owner: me, members: new Set([me, ...body.recipients]) });
            return json({ id, type: 3, name: body.name, recipients: others(state.channels.get(id)) });
        }
        const match = /^\/channels\/(\d+)(?:\/recipients\/(\d+))?$/.exec(path);
        const channel = match && state.channels.get(match[1]);
        if (!channel) return json({ message: "Unknown Channel", code: 10003 }, 404);
        if (method === "GET" && !match[2]) return json({ id: channel.id, type: 3, name: channel.name, recipients: others(channel) });
        if (method === "PUT" && match[2]) {
            if (refuseAdd.has(match[2])) return json({ message: "Maximum number of group DM recipients reached (25)", code: 30015 }, 400);
            channel.members.add(match[2]);
            return new Response(null, { status: 204 });
        }
        if (method === "DELETE" && match[2]) {
            channel.members.delete(match[2]);
            return new Response(null, { status: 204 });
        }
        if (method === "DELETE") {
            channel.members.delete(me);
            if (!channel.members.size) state.channels.delete(channel.id);
            return json({ id: channel.id });
        }
        return json({ message: "not found" }, 404);
    };
    return state;
}

let env;

beforeEach(() => {
    env = { DB: fakeD1(), ADMIN_CHAT_ORIGIN: ORIGIN, ADMIN_CHAT_TOKEN: TOKEN };
});

afterEach(() => {
    globalThis.fetch = realFetch;
});

describe("announce contacts", () => {
    test("keeps only valid handles of the announcing instance, at most 10", () => {
        const many = Array.from({ length: 14 }, (_, index) => `admin${index}@meow.example.com`);
        expect(
            cleanContacts(["meow@meow.example.com", "meow@meow.example.com", "evil@other.example.com", "Bad@meow.example.com", "a@meow.example.com", 4], "meow.example.com"),
        ).toEqual(["meow@meow.example.com"]);
        expect(cleanContacts(many, "meow.example.com")).toHaveLength(10);
        expect(cleanContacts(undefined, "meow.example.com")).toBeNull();
        expect(cleanContacts([], "meow.example.com")).toEqual([]);
    });

    test("comes out of the checked announce payload, and old payloads have none", () => {
        const withContacts = checkAnnouncePayload(announcePayload("meow.example.com", { contacts: ["meow@meow.example.com"] }), "meow.example.com");
        expect(withContacts.contacts).toEqual(["meow@meow.example.com"]);
        expect(checkAnnouncePayload(announcePayload("meow.example.com"), "meow.example.com").contacts).toBeNull();
    });

    test("are stored per instance, replaced, cleared by an empty list and kept when an announce has none", async () => {
        addInstance(env, "meow.example.com");
        await storeContacts(env, "meow.example.com", ["meow@meow.example.com"]);
        await storeContacts(env, "meow.example.com", ["purr@meow.example.com", "meow@meow.example.com"]);
        expect(await chatContacts(env)).toEqual(["purr@meow.example.com", "meow@meow.example.com"]);
        await storeContacts(env, "meow.example.com", null);
        expect(await chatContacts(env)).toHaveLength(2);
        await storeContacts(env, "meow.example.com", []);
        expect(await chatContacts(env)).toEqual([]);
    });

    test("only count for approved instances that aren't blocked", async () => {
        addInstance(env, "meow.example.com");
        addInstance(env, "pending.example.com", "pending");
        addInstance(env, "blocked.example.com");
        env.DB.sqlite.query("INSERT INTO blocks (kind, id, reason, at) VALUES ('instance', 'blocked.example.com', '', ?)").run(new Date().toISOString());
        await storeContacts(env, "meow.example.com", ["meow@meow.example.com"]);
        await storeContacts(env, "pending.example.com", ["new@pending.example.com"]);
        await storeContacts(env, "blocked.example.com", ["bad@blocked.example.com"]);
        expect(await chatContacts(env)).toEqual(["meow@meow.example.com"]);
    });

    test("never reach the published document", async () => {
        addInstance(env, "meow.example.com");
        await storeContacts(env, "meow.example.com", ["secretadmin@meow.example.com"]);
        const content = await buildContent(env);
        expect(content.instances.map((instance) => instance.id)).toEqual(["meow.example.com"]);
        expect(JSON.stringify(content)).not.toContain("secretadmin");
        expect(Object.keys(content.instances[0])).not.toContain("contacts");
    });
});

describe("admin group chat", () => {
    test("needs both secrets and an https origin", () => {
        expect(secretChatConfig({})).toBeNull();
        expect(secretChatConfig({ ADMIN_CHAT_ORIGIN: ORIGIN })).toBeNull();
        expect(secretChatConfig({ ADMIN_CHAT_ORIGIN: "http://hub.meow.example.com", ADMIN_CHAT_TOKEN: TOKEN })).toBeNull();
        expect(secretChatConfig({ ADMIN_CHAT_ORIGIN: `${ORIGIN}/app`, ADMIN_CHAT_TOKEN: TOKEN })).toEqual({ origin: ORIGIN, token: TOKEN, source: "secrets" });
    });

    test("refuses to open without an account", async () => {
        const result = await openAdminChat({ DB: env.DB }, "tiago");
        expect(result.error).toContain("Connect the admin chat account");
    });

    test("opens a named group DM, adds missing admins on a second open and closes it", async () => {
        addInstance(env, "meow.example.com");
        addInstance(env, "purr.example.com");
        await storeContacts(env, "meow.example.com", ["meow@meow.example.com", "ghost@meow.example.com"]);
        await storeContacts(env, "purr.example.com", ["purr@purr.example.com", "owner@purr.example.com"]);
        const users = { "meow@meow.example.com": "10", "purr@purr.example.com": "20", "owner@purr.example.com": "1" };
        const fake = fakeMeowcord({ users });

        const opened = await openAdminChat(env, "tiago");
        expect(opened.error).toBeUndefined();
        const [channel] = [...fake.channels.values()];
        expect(channel.name).toBe("Meowcord Admins");
        expect([...channel.members].sort()).toEqual(["1", "10", "20"]);
        let state = await chatState(env);
        expect(state.channel_id).toBe(channel.id);
        expect(state.member_count).toBe(3);
        expect(state.opened_by).toBe("tiago");
        expect(state.failed).toEqual([{ handle: "ghost@meow.example.com", reason: "no such user" }]);

        addInstance(env, "late.example.com");
        await storeContacts(env, "late.example.com", ["late@late.example.com", "full@late.example.com"]);
        users["late@late.example.com"] = "30";
        users["full@late.example.com"] = "31";
        fakeMeowcord({ users, refuseAdd: new Set(["31"]) }).channels.set(channel.id, channel);
        const reopened = await openAdminChat(env, "other-admin");
        expect(reopened.notice).toContain("Updated");
        expect([...channel.members].sort()).toEqual(["1", "10", "20", "30"]);
        state = await chatState(env);
        expect(state.channel_id).toBe(channel.id);
        expect(state.member_count).toBe(4);
        expect(state.opened_by).toBe("tiago");
        expect(state.failed.map((entry) => entry.handle).sort()).toEqual(["full@late.example.com", "ghost@meow.example.com"]);
        expect(state.failed.find((entry) => entry.handle === "full@late.example.com").reason).toContain("Maximum number");

        const closeFake = fakeMeowcord({ users });
        closeFake.channels.set(channel.id, channel);
        const closed = await closeAdminChat(env, "tiago");
        expect(closed.notice).toBe("Closed the admin group chat");
        expect(closeFake.channels.size).toBe(0);
        expect(await chatState(env)).toBeNull();

        const { results } = await env.DB.prepare("SELECT kind, level, actor, message FROM events WHERE kind = 'admin-chat' ORDER BY id").all();
        expect(results.map((row) => row.actor)).toEqual(["tiago", "other-admin", "tiago"]);
        expect(results[0].message).toContain(`opened the admin group chat ${channel.id} with 3 members`);
        expect(results[2].message).toContain("closed");
    });

    test("creates a new chat when the stored one is gone", async () => {
        addInstance(env, "meow.example.com");
        await storeContacts(env, "meow.example.com", ["meow@meow.example.com", "purr@meow.example.com"]);
        const fake = fakeMeowcord({ users: { "meow@meow.example.com": "10", "purr@meow.example.com": "11" } });
        await openAdminChat(env, "tiago");
        const first = (await chatState(env)).channel_id;
        fake.channels.clear();
        await openAdminChat(env, "tiago");
        const second = (await chatState(env)).channel_id;
        expect(second).not.toBe(first);
        expect(fake.channels.has(second)).toBe(true);
    });

    test("logs a failure and keeps no state when nobody resolves", async () => {
        addInstance(env, "meow.example.com");
        await storeContacts(env, "meow.example.com", ["ghost@meow.example.com"]);
        fakeMeowcord({ users: {} });
        const result = await openAdminChat(env, "tiago");
        expect(result.error).toContain("at least two");
        expect(await chatState(env)).toBeNull();
        const row = await env.DB.prepare("SELECT level FROM events WHERE kind = 'admin-chat'").first();
        expect(row.level).toBe("error");
    });

    test("runs from the dashboard behind a session and a same-origin form post", async () => {
        addInstance(env, "meow.example.com");
        await storeContacts(env, "meow.example.com", ["meow@meow.example.com", "purr@meow.example.com"]);
        fakeMeowcord({ users: { "meow@meow.example.com": "10", "purr@meow.example.com": "11" } });
        const token = randomBase64Url(32);
        env.DB.sqlite
            .query("INSERT INTO sessions (token_hash, sub, username, created_at, expires_at) VALUES (?, 'sub', 'tiago', ?, ?)")
            .run(await sha256Hex(token), Date.now(), Date.now() + 60_000);
        const ctx = { waitUntil() {} };
        const cookie = `__Host-registry_session=${token}`;
        const post = (origin) =>
            handleAdmin(
                new Request("https://registry.example.com/admin/chat", { method: "POST", headers: { cookie, origin }, body: new URLSearchParams({ action: "open" }) }),
                env,
                ctx,
            );
        expect((await post("https://evil.example.com")).status).toBe(403);
        expect(await chatState(env)).toBeNull();
        const response = await post("https://registry.example.com");
        expect(response.status).toBe(303);
        expect(response.headers.get("location")).toContain("notice=Opened");
        const overview = await handleAdmin(new Request("https://registry.example.com/admin", { headers: { cookie } }), env, ctx);
        const page = await overview.text();
        expect(page).toContain("Admin group chat");
        expect(page).toContain((await chatState(env)).channel_id);
        expect(page).toContain("Close admin group chat");

        const unconfigured = await handleAdmin(new Request("https://registry.example.com/admin", { headers: { cookie } }), { DB: env.DB }, ctx);
        const unconfiguredPage = await unconfigured.text();
        expect(unconfiguredPage).toContain("No account is connected");
        expect(unconfiguredPage).toContain('value="connect"');
        expect(unconfiguredPage).toMatch(/value="open" class="primary" disabled/);
    });
});

describe("admin chat account", () => {
    const SEED = randomBase64Url(32);
    const ACCOUNT_TOKEN = "account-token";

    function fakeLogin({ mfa = false, captcha = false } = {}) {
        const calls = [];
        globalThis.fetch = async (input, init = {}) => {
            const url = new URL(input);
            const path = url.pathname.replace(/^\/api\/v9/, "");
            const body = init.body ? JSON.parse(init.body) : null;
            calls.push({ path, body, authorization: init.headers?.authorization });
            const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
            expect(url.origin).toBe(ORIGIN);
            if (path === "/auth/login") {
                if (captcha) return json({ captcha_key: ["captcha-required"], captcha_service: "cap" }, 400);
                if (body.password !== "hunter2")
                    return json(
                        { code: 50035, message: "Invalid Form Body", errors: { login: { _errors: [{ code: "INVALID_LOGIN", message: "Login or password is invalid." }] } } },
                        400,
                    );
                return mfa ? json({ token: null, mfa: true, totp: true, backup: true, ticket: "ticket-1" }) : json({ token: ACCOUNT_TOKEN, user_id: "1" });
            }
            if (path === "/auth/mfa/totp")
                return body.code === "123456" && body.ticket === "ticket-1" ? json({ token: ACCOUNT_TOKEN }) : json({ message: "Invalid two-factor code", code: 60008 }, 400);
            if (path === "/users/@me") return init.headers.authorization === ACCOUNT_TOKEN ? json({ id: "1", username: "admins" }) : json({ message: "401: Unauthorized" }, 401);
            if (path === "/auth/logout") return new Response(null, { status: 204 });
            return json({ message: "not found" }, 404);
        };
        return calls;
    }

    beforeEach(() => {
        env = { DB: fakeD1(), REGISTRY_SIGNING_KEY: SEED };
        addInstance(env, "hub.meow.example.com");
    });

    test("signs in, keeps only the encrypted token and replaces the secrets", async () => {
        const calls = fakeLogin();
        env.ADMIN_CHAT_ORIGIN = "https://old.example.com";
        env.ADMIN_CHAT_TOKEN = "old";
        expect((await connectChatAccount(env, "tiago", { instance: "hub.meow.example.com", login: "admins", password: "wrong" })).error).toContain("Login or password is invalid");
        const result = await connectChatAccount(env, "tiago", { instance: "hub.meow.example.com", login: "admins", password: "hunter2" });
        expect(result.notice).toContain("Connected admins");
        const stored = JSON.stringify(env.DB.sqlite.query("SELECT * FROM admin_chat_account").all());
        expect(stored).not.toContain(ACCOUNT_TOKEN);
        expect(stored).not.toContain("hunter2");
        expect(await adminChatConfig(env)).toEqual({ origin: ORIGIN, token: ACCOUNT_TOKEN, source: "account", username: "admins", user_id: "1" });
        expect(calls.find((call) => call.path === "/users/@me").authorization).toBe(ACCOUNT_TOKEN);
        expect(await adminChatConfig({ ...env, REGISTRY_SIGNING_KEY: randomBase64Url(32) })).toEqual({ origin: "https://old.example.com", token: "old", source: "secrets" });
    });

    test("asks for a two-factor code and finishes with it", async () => {
        fakeLogin({ mfa: true });
        const first = await connectChatAccount(env, "tiago", { instance: "hub.meow.example.com", login: "admins", password: "hunter2" });
        expect(first.mfa).toEqual({ origin: ORIGIN, ticket: "ticket-1", totp: true, backup: true });
        expect(await adminChatConfig(env)).toBeNull();
        expect((await finishChatAccountMfa(env, "tiago", { instance: "hub.meow.example.com", ticket: "ticket-1", method: "totp", code: "000000" })).error).toContain(
            "Invalid two-factor code",
        );
        const done = await finishChatAccountMfa(env, "tiago", { instance: "hub.meow.example.com", ticket: "ticket-1", method: "totp", code: "123 456" });
        expect(done.notice).toContain("Connected");
        expect((await adminChatConfig(env)).token).toBe(ACCOUNT_TOKEN);
    });

    test("explains a captcha and refuses instances that aren't approved", async () => {
        fakeLogin({ captcha: true });
        expect((await connectChatAccount(env, "tiago", { instance: "hub.meow.example.com", login: "admins", password: "hunter2" })).error).toContain("captcha");
        addInstance(env, "pending.example.com", "pending");
        expect((await connectChatAccount(env, "tiago", { instance: "pending.example.com", login: "admins", password: "hunter2" })).error).toBe("Pick an approved instance");
    });

    test("disconnecting signs the token out and forgets it", async () => {
        const calls = fakeLogin();
        await connectChatAccount(env, "tiago", { instance: "hub.meow.example.com", login: "admins", password: "hunter2" });
        const result = await disconnectChatAccount(env, "tiago");
        expect(result.notice).toContain("signed its token out");
        expect(calls.at(-1)).toEqual({ path: "/auth/logout", body: {}, authorization: ACCOUNT_TOKEN });
        expect(await adminChatConfig(env)).toBeNull();
        expect((await disconnectChatAccount(env, "tiago")).error).toBe("No account is connected");
    });
});
