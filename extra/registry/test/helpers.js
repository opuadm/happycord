import { signEnvelope, toBase64Url } from "../src/crypto.js";

export async function makeInstanceKey() {
    const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const publicKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)));
    return { privateKey: keys.privateKey, publicKey };
}

export function announcePayload(id, overrides = {}) {
    return { type: "announce", id, sent_at: new Date().toISOString(), nonce: toBase64Url(crypto.getRandomValues(new Uint8Array(16))), ...overrides };
}

export async function signedAnnounce(key, id, overrides = {}, keyId = id) {
    return signEnvelope(announcePayload(id, overrides), key.privateKey, keyId);
}

export function startFakeInstance({ key, guilds = [] }) {
    const state = { key, guilds, wellKnownOverrides: {}, discoveryKey: key, requests: [] };
    const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(request) {
            const url = new URL(request.url);
            const id = `127.0.0.1:${server.port}`;
            const origin = `http://${id}`;
            state.requests.push(url.pathname);
            if (url.pathname === "/.well-known/meowcord") {
                return Response.json({
                    protocol: 1,
                    software: "meowcord",
                    version: "test",
                    id,
                    url: origin,
                    name: "Fake instance",
                    description: "An instance served by the registry tests",
                    icon_url: `${origin}/icon.png`,
                    public_key: state.key.publicKey,
                    registration: "open",
                    federation: { enabled: true, accepts_unlisted: false },
                    discovery_url: `${origin}/.well-known/meowcord/discovery`,
                    ...state.wellKnownOverrides,
                });
            }
            if (url.pathname === "/.well-known/meowcord/discovery") {
                const payload = {
                    instance: id,
                    issued_at: new Date().toISOString(),
                    guilds: state.guilds.map((guild) => ({ ...guild, id: `@${guild.snowflake}@${id}`, invite_url: `${origin}/invite/${guild.snowflake}`, snowflake: undefined })),
                };
                return Response.json(await signEnvelope(payload, state.discoveryKey.privateKey, id));
            }
            if (url.pathname === "/instances.json") {
                return Response.json([{ id: "meowcord-registry-test.example.com", name: "Listed by file", url: "https://meowcord-registry-test.example.com", source_url: null }]);
            }
            return new Response("not found", { status: 404 });
        },
    });
    return { server, state, id: `127.0.0.1:${server.port}`, origin: `http://127.0.0.1:${server.port}` };
}
