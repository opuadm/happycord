import { fromBase64Url, randomBase64Url, sha256Base64Url, sha256Hex } from "../crypto.js";
import { logEvent } from "../db.js";

const SESSION_COOKIE = "__Host-registry_session";
const STATE_COOKIE = "__Host-registry_oidc";
const SESSION_LIFETIME = 12 * 60 * 60 * 1000;
const STATE_LIFETIME = 10 * 60 * 1000;

let providerCache = null;

async function provider(env, { refreshKeys = false } = {}) {
    const issuer = env.OIDC_ISSUER;
    if (!providerCache || providerCache.issuer !== issuer || providerCache.expires < Date.now()) {
        const response = await fetch(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(8000) });
        if (!response.ok) throw new Error(`openid-configuration answered HTTP ${response.status}`);
        const metadata = await response.json();
        if (metadata.issuer !== issuer) throw new Error("openid-configuration issuer does not match");
        providerCache = { issuer, metadata, jwks: null, expires: Date.now() + 60 * 60 * 1000 };
    }
    if (!providerCache.jwks || refreshKeys) {
        const response = await fetch(providerCache.metadata.jwks_uri, { signal: AbortSignal.timeout(8000) });
        if (!response.ok) throw new Error(`jwks answered HTTP ${response.status}`);
        providerCache.jwks = (await response.json()).keys ?? [];
    }
    return providerCache;
}

export function parseCookies(request) {
    const cookies = new Map();
    for (const part of (request.headers.get("cookie") ?? "").split(";")) {
        const index = part.indexOf("=");
        if (index > 0) cookies.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
    }
    return cookies;
}

function cookie(name, value, maxAgeSeconds) {
    return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function redirectUri(request) {
    return `${new URL(request.url).origin}/admin/callback`;
}

export function oidcConfigured(env) {
    return Boolean(env.OIDC_ISSUER && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET);
}

export async function startLogin(request, env) {
    const { metadata } = await provider(env);
    const state = randomBase64Url(32);
    const verifier = randomBase64Url(32);
    const nonce = randomBase64Url(16);
    await env.DB.prepare("INSERT INTO oidc_states (state, verifier, nonce, created_at) VALUES (?, ?, ?, ?)").bind(state, verifier, nonce, Date.now()).run();
    const url = new URL(metadata.authorization_endpoint);
    url.search = new URLSearchParams({
        response_type: "code",
        client_id: env.OIDC_CLIENT_ID,
        redirect_uri: redirectUri(request),
        scope: "openid profile groups",
        state,
        nonce,
        code_challenge: await sha256Base64Url(verifier),
        code_challenge_method: "S256",
    }).toString();
    return new Response(null, {
        status: 302,
        headers: { location: url.toString(), "set-cookie": cookie(STATE_COOKIE, state, STATE_LIFETIME / 1000), "cache-control": "no-store" },
    });
}

export async function verifyIdToken(token, { jwks, issuer, clientId, nonce, now = Date.now() }) {
    const parts = typeof token === "string" ? token.split(".") : [];
    if (parts.length !== 3) throw new Error("id_token is not a JWT");
    const decode = (part) => JSON.parse(new TextDecoder().decode(fromBase64Url(part)));
    const header = decode(parts[0]);
    if (header.alg !== "RS256") throw new Error("id_token is not RS256");
    const jwk = jwks.find((key) => key.kid === header.kid && key.kty === "RSA");
    if (!jwk) throw new Error("id_token key is not in the JWKS");
    const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
        "verify",
    ]);
    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromBase64Url(parts[2]), signed))) throw new Error("id_token signature does not verify");
    const claims = decode(parts[1]);
    const seconds = Math.floor(now / 1000);
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== issuer) throw new Error("id_token issuer does not match");
    if (!audiences.includes(clientId)) throw new Error("id_token audience does not match");
    if (claims.azp && claims.azp !== clientId) throw new Error("id_token azp does not match");
    if (typeof claims.exp !== "number" || claims.exp < seconds - 60) throw new Error("id_token expired");
    if (typeof claims.iat === "number" && claims.iat > seconds + 300) throw new Error("id_token is from the future");
    if (claims.nonce !== nonce) throw new Error("id_token nonce does not match");
    if (typeof claims.sub !== "string" || !claims.sub) throw new Error("id_token has no subject");
    return claims;
}

export async function finishLogin(request, env) {
    const url = new URL(request.url);
    if (url.searchParams.get("error")) throw new Error(`hrtID refused the sign-in: ${url.searchParams.get("error")}`);
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";
    if (!state || !code) throw new Error("the callback is missing code or state");
    if (parseCookies(request).get(STATE_COOKIE) !== state) throw new Error("the sign-in started in another browser or expired, start again");
    const stored = await env.DB.prepare("DELETE FROM oidc_states WHERE state = ? RETURNING verifier, nonce, created_at").bind(state).first();
    if (!stored || stored.created_at < Date.now() - STATE_LIFETIME) throw new Error("the sign-in expired, start again");
    const { metadata } = await provider(env);
    const basic = btoa(`${encodeURIComponent(env.OIDC_CLIENT_ID)}:${encodeURIComponent(env.OIDC_CLIENT_SECRET)}`);
    const tokenResponse = await fetch(metadata.token_endpoint, {
        method: "POST",
        headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri(request), code_verifier: stored.verifier }),
        signal: AbortSignal.timeout(8000),
    });
    const tokens = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok || !tokens.id_token) throw new Error(`the token exchange failed: ${tokens.error ?? `HTTP ${tokenResponse.status}`}`);
    const options = { issuer: env.OIDC_ISSUER, clientId: env.OIDC_CLIENT_ID, nonce: stored.nonce };
    let claims;
    try {
        claims = await verifyIdToken(tokens.id_token, { ...options, jwks: (await provider(env)).jwks });
    } catch (error) {
        if (error.message !== "id_token key is not in the JWKS") throw error;
        claims = await verifyIdToken(tokens.id_token, { ...options, jwks: (await provider(env, { refreshKeys: true })).jwks });
    }
    const username = claims.preferred_username ?? claims.name ?? claims.sub;
    if (!Array.isArray(claims.groups) || !claims.groups.includes(env.ADMIN_GROUP)) {
        await logEvent(env, { kind: "admin", level: "warn", actor: username, message: `sign-in refused, not in the ${env.ADMIN_GROUP} group` });
        throw new Error(`your hrtID account is not in the ${env.ADMIN_GROUP} group`);
    }
    const token = randomBase64Url(32);
    const now = Date.now();
    await env.DB.prepare("INSERT INTO sessions (token_hash, sub, username, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
        .bind(await sha256Hex(token), claims.sub, username, now, now + SESSION_LIFETIME)
        .run();
    await logEvent(env, { kind: "admin", actor: username, message: "signed in" });
    const headers = new Headers({ location: "/admin", "cache-control": "no-store" });
    headers.append("set-cookie", cookie(SESSION_COOKIE, token, SESSION_LIFETIME / 1000));
    headers.append("set-cookie", cookie(STATE_COOKIE, "", 0));
    return new Response(null, { status: 303, headers });
}

export async function currentSession(request, env) {
    const token = parseCookies(request).get(SESSION_COOKIE);
    if (!token) return null;
    return env.DB.prepare("SELECT sub, username, expires_at FROM sessions WHERE token_hash = ? AND expires_at > ?")
        .bind(await sha256Hex(token), Date.now())
        .first();
}

export async function endSession(request, env) {
    const token = parseCookies(request).get(SESSION_COOKIE);
    if (token)
        await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?")
            .bind(await sha256Hex(token))
            .run();
    return cookie(SESSION_COOKIE, "", 0);
}
