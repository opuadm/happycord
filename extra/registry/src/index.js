import { handleAdmin } from "./admin/pages.js";
import { handleAnnounce } from "./announce.js";
import { runScheduled } from "./cron.js";
import { REGISTRY_KEY_ID } from "./crypto.js";
import { logEvent } from "./db.js";
import { registryEnvelope, registrySigningKey } from "./registry.js";

const corsHeaders = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" };

async function route(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    if (request.method === "OPTIONS" && pathname.startsWith("/v1/")) return new Response(null, { status: 204, headers: corsHeaders });
    if (pathname === "/v1/registry") {
        if (request.method !== "GET" && request.method !== "HEAD") return new Response("method not allowed", { status: 405 });
        const publication = await registryEnvelope(env);
        return new Response(request.method === "HEAD" ? null : publication.envelope, {
            headers: {
                ...corsHeaders,
                "content-type": "application/json; charset=utf-8",
                "cache-control": "public, max-age=60",
                "x-registry-sequence": String(publication.sequence),
            },
        });
    }
    if (pathname === "/v1/announce") {
        if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
        const response = await handleAnnounce(request, env, ctx);
        for (const [key, value] of Object.entries(corsHeaders)) response.headers.set(key, value);
        return response;
    }
    if (pathname === "/admin" || pathname.startsWith("/admin/")) return handleAdmin(request, env, ctx);
    if (pathname === "/") {
        const { publicKey } = await registrySigningKey(env);
        return Response.json(
            {
                service: "meowcord-registry",
                protocol: 1,
                registry: `${url.origin}/v1/registry`,
                announce: `${url.origin}/v1/announce`,
                key_id: REGISTRY_KEY_ID,
                public_key: publicKey,
                source: "https://github.com/meowcorded/meowcord/tree/main/extra/registry",
            },
            { headers: { ...corsHeaders, "cache-control": "public, max-age=300" } },
        );
    }
    return Response.json({ error: "not_found" }, { status: 404 });
}

export default {
    async fetch(request, env, ctx) {
        try {
            return await route(request, env, ctx);
        } catch (error) {
            ctx.waitUntil(logEvent(env, { kind: "error", level: "error", message: `${request.method} ${new URL(request.url).pathname}: ${error.message}` }).catch(() => {}));
            return Response.json({ error: "internal_error" }, { status: 500 });
        }
    },
    async scheduled(controller, env, ctx) {
        ctx.waitUntil(runScheduled(env));
    },
};
