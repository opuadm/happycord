import { describe, expect, test } from "bun:test";
import { escapeHtml, html } from "../src/admin/html.js";
import { verifyIdToken } from "../src/admin/oidc.js";
import { canonicalId } from "../src/admin/pages.js";
import { checkAnnouncePayload } from "../src/announce.js";
import { parseInstancesFile } from "../src/cron.js";
import { fromBase64Url, importSigningSeed, signEnvelope, toBase64Url, verifyEnvelope } from "../src/crypto.js";
import { parseDiscoveryPayload } from "../src/instances.js";
import { instanceIdFromUrl, isPrivateAddress, parseInstanceId } from "../src/net.js";
import { instanceState } from "../src/registry.js";
import { announcePayload, makeInstanceKey } from "./helpers.js";

describe("instance ids", () => {
    test("accepts public hosts and ports other than 443", () => {
        expect(parseInstanceId("meow.example.com")).toMatchObject({ origin: "https://meow.example.com" });
        expect(parseInstanceId("meow.example.com:8443")).toMatchObject({ origin: "https://meow.example.com:8443", port: 8443 });
        expect(parseInstanceId("ang.taild5450d.ts.net")).not.toBeNull();
    });

    test("refuses localhost, IP addresses, private names and malformed ids", () => {
        for (const id of [
            "localhost",
            "localhost:3001",
            "127.0.0.1",
            "10.0.0.1:80",
            "meow",
            "meow.local",
            "meow.internal",
            "x.home.arpa",
            "a.test",
            "meow.example",
            "Meow.com",
            "meow.com:443",
            "meow.com:0",
            "-a.com",
            "a..com",
            "a.com/x",
            "a.com:99999",
        ]) {
            expect(parseInstanceId(id)).toBeNull();
        }
    });

    test("allows local ids over http only when private hosts are allowed", () => {
        expect(parseInstanceId("127.0.0.1:3001", { allowPrivate: true })).toMatchObject({ origin: "http://127.0.0.1:3001" });
        expect(parseInstanceId("localhost:3001", { allowPrivate: true })).toMatchObject({ origin: "http://localhost:3001" });
    });

    test("derives the id from a URL", () => {
        expect(instanceIdFromUrl("https://Tabaque.lol/")?.id).toBe("tabaque.lol");
        expect(instanceIdFromUrl("https://cord.area12.lol:8443/x")?.id).toBe("cord.area12.lol:8443");
        expect(instanceIdFromUrl("http://tabaque.lol")).toBeNull();
        expect(instanceIdFromUrl("https://user:pass@tabaque.lol")).toBeNull();
    });

    test("recognises canonical object ids", () => {
        expect(canonicalId("@123@meow.example.com")).toBe("@123@meow.example.com");
        expect(canonicalId("@abc@meow.example.com")).toBeNull();
        expect(canonicalId("@123@localhost")).toBeNull();
    });
});

describe("private addresses", () => {
    test("covers loopback, private, link-local, CGNAT and mapped ranges", () => {
        for (const address of [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "::1",
            "::",
            "fd00::1",
            "fe80::1",
            "::ffff:10.0.0.1",
            "224.0.0.1",
        ]) {
            expect(isPrivateAddress(address)).toBe(true);
        }
        for (const address of ["1.1.1.1", "172.32.0.1", "8.8.8.8", "2606:4700::1111", "::ffff:1.1.1.1"]) {
            expect(isPrivateAddress(address)).toBe(false);
        }
    });
});

describe("envelopes", () => {
    test("round-trips and refuses tampering", async () => {
        const key = await makeInstanceKey();
        const envelope = await signEnvelope({ a: 1 }, key.privateKey, "meow.example.com");
        expect((await verifyEnvelope(envelope, key.publicKey)).payload).toEqual({ a: 1 });
        const tampered = { ...envelope, payload: toBase64Url(new TextEncoder().encode('{"a":2}')) };
        await expect(verifyEnvelope(tampered, key.publicKey)).rejects.toThrow("signature does not verify");
        const other = await makeInstanceKey();
        await expect(verifyEnvelope(envelope, other.publicKey)).rejects.toThrow();
    });

    test("derives the public key from a raw seed", async () => {
        const seed = toBase64Url(new Uint8Array(32).fill(7));
        const { publicKey, privateKey } = await importSigningSeed(seed);
        expect(fromBase64Url(publicKey)).toHaveLength(32);
        const envelope = await signEnvelope({ ok: true }, privateKey, "registry-1");
        expect((await verifyEnvelope(envelope, publicKey)).payload).toEqual({ ok: true });
        await expect(importSigningSeed("short")).rejects.toThrow();
    });
});

describe("announce payload", () => {
    test("accepts a fresh announce", () => {
        const payload = announcePayload("meow.example.com");
        expect(checkAnnouncePayload(payload, "meow.example.com").instance.id).toBe("meow.example.com");
    });

    test("refuses wrong type, key id, time and nonce", () => {
        expect(checkAnnouncePayload({ ...announcePayload("meow.example.com"), type: "hello" }, "meow.example.com").error).toBeDefined();
        expect(checkAnnouncePayload(announcePayload("meow.example.com"), "other.example.com").error).toBeDefined();
        expect(checkAnnouncePayload(announcePayload("localhost:3001"), "localhost:3001").error).toBeDefined();
        expect(checkAnnouncePayload(announcePayload("meow.example.com", { sent_at: "2020-01-01T00:00:00Z" }), "meow.example.com").error).toContain("5 minutes");
        expect(checkAnnouncePayload(announcePayload("meow.example.com", { nonce: toBase64Url(new Uint8Array(8)) }), "meow.example.com").error).toContain("16 bytes");
    });
});

describe("discovery payload", () => {
    const instance = parseInstanceId("meow.example.com");

    test("keeps valid servers and drops foreign or malformed ones", () => {
        const guilds = parseDiscoveryPayload(
            {
                instance: "meow.example.com",
                guilds: [
                    { id: "@1@meow.example.com", name: "Cats", description: "", icon_url: "", member_count: 3, invite_url: "https://meow.example.com/invite/a" },
                    { id: "@2@evil.example.com", name: "Spoof", invite_url: "https://meow.example.com/invite/b" },
                    { id: "@3@meow.example.com", name: "Elsewhere", invite_url: "https://evil.example.com/invite/c" },
                    { id: "@4@meow.example.com", name: "", invite_url: "https://meow.example.com/invite/d" },
                    { id: "@5@meow.example.com", name: "Negative", member_count: -1, invite_url: "https://meow.example.com/invite/e" },
                ],
            },
            instance,
        );
        expect(guilds.map((guild) => guild.id)).toEqual(["@1@meow.example.com", "@5@meow.example.com"]);
        expect(guilds[1].member_count).toBe(0);
        expect(guilds[0].icon_url).toBeNull();
    });

    test("refuses a list for another instance", () => {
        expect(() => parseDiscoveryPayload({ instance: "other.example.com", guilds: [] }, instance)).toThrow();
    });
});

describe("instances.json", () => {
    test("reads entries and derives ids", () => {
        const entries = parseInstancesFile([
            { name: "Tabaque", url: "https://tabaque.lol", source_url: "https://github.com/PoZorKino/tabaque" },
            { name: "No source", url: "https://orcbin.com", source_url: null },
            { name: "Mismatch", id: "other.com", url: "https://mismatch.com" },
            { name: "Bad", url: "http://insecure.com" },
        ]);
        expect(entries).toEqual([
            { id: "tabaque.lol", url: "https://tabaque.lol", name: "Tabaque", source_url: "https://github.com/PoZorKino/tabaque", previous_ids: [] },
            { id: "orcbin.com", url: "https://orcbin.com", name: "No source", source_url: null, previous_ids: [] },
        ]);
    });

    test("reads the instances.json in this repository", async () => {
        const file = await Bun.file(new URL("../../../instances.json", import.meta.url)).json();
        expect(parseInstancesFile(file)).toHaveLength(file.length);
    });
});

describe("instance state", () => {
    test("is active only with a key, federation on and a supported protocol", () => {
        expect(instanceState({ status: "approved", public_key: "k", federation_enabled: 1, protocol: 1 })).toBe("active");
        expect(instanceState({ status: "approved", public_key: null, federation_enabled: 0, protocol: null })).toBe("listed");
        expect(instanceState({ status: "approved", public_key: "k", federation_enabled: 0, protocol: 1 })).toBe("listed");
        expect(instanceState({ status: "suspended", public_key: "k", federation_enabled: 1, protocol: 1 })).toBe("suspended");
    });
});

describe("id tokens", () => {
    async function makeToken(claims, { kid = "k1" } = {}) {
        const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, [
            "sign",
            "verify",
        ]);
        const jwk = { ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid };
        const encode = (value) => toBase64Url(new TextEncoder().encode(JSON.stringify(value)));
        const signingInput = `${encode({ alg: "RS256", kid, typ: "JWT" })}.${encode(claims)}`;
        const signature = toBase64Url(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(signingInput))));
        return { token: `${signingInput}.${signature}`, jwks: [jwk] };
    }
    const now = Date.now();
    const claims = {
        iss: "https://id.estrogen.delivery",
        aud: "client",
        sub: "u1",
        nonce: "n1",
        exp: Math.floor(now / 1000) + 300,
        iat: Math.floor(now / 1000),
        groups: ["admins"],
    };
    const options = { issuer: "https://id.estrogen.delivery", clientId: "client", nonce: "n1", now };

    test("accepts a valid token", async () => {
        const { token, jwks } = await makeToken(claims);
        expect((await verifyIdToken(token, { ...options, jwks })).groups).toEqual(["admins"]);
    });

    test("refuses a wrong audience, nonce, issuer, expiry or key", async () => {
        for (const change of [{ aud: "other" }, { nonce: "n2" }, { iss: "https://evil.example.com" }, { exp: Math.floor(now / 1000) - 600 }]) {
            const { token, jwks } = await makeToken({ ...claims, ...change });
            await expect(verifyIdToken(token, { ...options, jwks })).rejects.toThrow();
        }
        const { token } = await makeToken(claims);
        const { jwks: otherKeys } = await makeToken(claims);
        await expect(verifyIdToken(token, { ...options, jwks: otherKeys })).rejects.toThrow("signature");
    });
});

describe("html", () => {
    test("escapes interpolated values", () => {
        expect(escapeHtml(`<a href="x">'&`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
        expect(html`<p>${"<script>"}</p>${[html`<b>${"&"}</b>`]}`.value).toBe("<p>&lt;script&gt;</p><b>&amp;</b>");
    });
});
