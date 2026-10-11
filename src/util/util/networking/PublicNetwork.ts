import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { request as requestHttp, IncomingMessage } from "node:http";
import { request as requestHttps } from "node:https";
import { Config } from "../Config";
import { outboundProxy, RawExchange, socksExchange } from "./SocksTransport";

const privateV4 = new BlockList();
const privateV6 = new BlockList();
for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 3],
] as const)
    privateV4.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
    ["::", 127],
    ["::ffff:0:0", 96],
    ["64:ff9b::", 96],
    ["100::", 64],
    ["2001::", 23],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
] as const)
    privateV6.addSubnet(network, prefix, "ipv6");

export function isPrivateAddress(address: string) {
    const family = isIP(address);
    if (!family) return true;
    if (family === 4) return privateV4.check(address, "ipv4");
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    return mapped ? privateV4.check(mapped[1], "ipv4") : privateV6.check(address, "ipv6");
}

export async function isPublicUrl(url: string | URL, opts: { httpsOnly?: boolean } = {}) {
    if (!URL.canParse(url)) return false;
    const parsed = new URL(url);
    if (Config.get().security.allowPrivateNetworkRequests) return /^https?:$/.test(parsed.protocol);
    if (parsed.protocol !== "https:" && (opts.httpsOnly || parsed.protocol !== "http:")) return false;
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(host)
        ? [host]
        : await lookup(host, { all: true, verbatim: true }).then(
              (results) => results.map(({ address }) => address),
              () => [],
          );
    return addresses.length > 0 && !addresses.some(isPrivateAddress);
}

export interface PublicFetchLimits {
    maxBytes?: number;
    timeoutMs?: number;
    trustedCdnOrigin?: string;
    allowExternal?: boolean;
}

export function isTrustedCdnAsset(url: URL, origin?: string) {
    if (!origin || !URL.canParse(origin) || url.origin !== new URL(origin).origin || /%2f|%5c|%00/i.test(url.pathname)) return false;
    return /^\/(?:attachments\/\d+\/\d+\/[^/]+|(?:avatars|icons|banners|splashes|emojis|stickers)\/\d+\/(?:[^/]+)|(?:emojis|stickers)\/\d+(?:\.[a-z]+)?)$/.test(url.pathname);
}

async function resolveFetchAddress(url: URL, signal: AbortSignal, trustedCdnOrigin?: string) {
    signal.throwIfAborted();
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid public HTTP URL");
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    let abort = () => {};
    let addresses;
    try {
        addresses = isIP(hostname)
            ? [{ address: hostname, family: isIP(hostname) }]
            : await Promise.race([
                  lookup(hostname, { all: true, verbatim: true }),
                  new Promise<never>((_, reject) => {
                      abort = () => reject(new Error("Public URL request aborted"));
                      signal.addEventListener("abort", abort, { once: true });
                      if (signal.aborted) abort();
                  }),
              ]);
    } finally {
        signal.removeEventListener("abort", abort);
    }
    signal.throwIfAborted();
    if (
        !addresses.length ||
        (!Config.get().security.allowPrivateNetworkRequests && !isTrustedCdnAsset(url, trustedCdnOrigin) && addresses.some(({ address }) => isPrivateAddress(address)))
    )
        throw new Error("Public URL resolves to a forbidden address");
    return addresses[0];
}

async function readPublicResponse(response: IncomingMessage, maxBytes: number, method: string) {
    if (method === "HEAD" || [204, 205, 304].includes(response.statusCode ?? 0)) {
        response.destroy();
        return null;
    }
    if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") throw new Error("Compressed public response is not supported");
    const length = response.headers["content-length"];
    if (length && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maxBytes)) throw new Error("Public response exceeds byte limit");
    const parts: Buffer[] = [];
    let bytes = 0;
    for await (const part of response) {
        const chunk = Buffer.from(part);
        bytes += chunk.length;
        if (bytes > maxBytes) throw new Error("Public response exceeds byte limit");
        parts.push(chunk);
    }
    if (!response.complete) throw new Error("Public response was interrupted");
    return Buffer.concat(parts);
}

export async function fetchPublicUrl(url: string, init: RequestInit = {}, redirects = 3, limits: PublicFetchLimits = {}): Promise<Response> {
    const maxBytes = limits.maxBytes ?? 5 * 1024 * 1024;
    const timeoutMs = limits.timeoutMs ?? 15000;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 64 * 1024 * 1024 || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000)
        throw new Error("Invalid public fetch limits");
    if (!Number.isSafeInteger(redirects) || redirects < 0 || redirects > 5) throw new Error("Invalid public redirect limit");
    if (init.body != null && typeof init.body !== "string" && !(init.body instanceof Uint8Array)) throw new Error("Unsupported public request body");
    const body = init.body == null ? undefined : Buffer.from(init.body);
    if (body && body.length > maxBytes) throw new Error("Public request exceeds byte limit");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Public URL request timed out")), timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    const proxy = outboundProxy();
    const exchangeDirect = (target: URL, address: { address: string; family: number }, method: string, outgoing: Record<string, string>, payload?: Buffer) =>
        new Promise<RawExchange>((resolve, reject) => {
            const request = (target.protocol === "https:" ? requestHttps : requestHttp)(
                target,
                {
                    method,
                    headers: outgoing,
                    agent: false,
                    family: address.family,
                    signal,
                    lookup: (_hostname, options, callback) => callback(null, options.all ? [address] : address.address, address.family),
                },
                (response) => {
                    const status = response.statusCode ?? 0;
                    const headers = Object.entries(response.headers).flatMap(([name, values]) =>
                        (Array.isArray(values) ? values : values === undefined ? [] : [values]).map((value): [string, string] => [name, value]),
                    );
                    if ([301, 302, 303, 307, 308].includes(status)) {
                        response.destroy();
                        return resolve({ status, headers, body: null });
                    }
                    readPublicResponse(response, maxBytes, method).then(
                        (body) => resolve({ status, headers, body }),
                        (error) => {
                            response.destroy();
                            reject(error);
                        },
                    );
                },
            );
            request.on("error", reject);
            request.end(payload);
        });
    const requestUrl = async (target: URL, remaining: number, method: string, headers: Headers, payload?: Buffer): Promise<Response> => {
        if (limits.allowExternal === false && !isTrustedCdnAsset(target, limits.trustedCdnOrigin)) throw new Error("External public requests are disabled");
        const address = await resolveFetchAddress(target, signal, limits.trustedCdnOrigin);
        const outgoing = Object.fromEntries(headers.entries());
        outgoing["accept-encoding"] = "identity";
        delete outgoing.host;
        delete outgoing.connection;
        delete outgoing["transfer-encoding"];
        delete outgoing["content-length"];
        if (payload) outgoing["content-length"] = String(payload.length);
        const viaProxy = !isTrustedCdnAsset(target, limits.trustedCdnOrigin) && !isPrivateAddress(address.address) && proxy !== "direct";
        if (viaProxy && !proxy) throw new Error("PUBLIC_FETCH_PROXY is not set, so requests to user-chosen URLs are refused");
        const exchange =
            viaProxy && proxy
                ? await socksExchange(proxy, target, address.address, method, outgoing, payload, signal, maxBytes)
                : await exchangeDirect(target, address, method, outgoing, payload);
        const location = exchange.headers.find(([name]) => name === "location")?.[1];
        if ([301, 302, 303, 307, 308].includes(exchange.status) && location && init.redirect !== "manual") {
            if (init.redirect === "error") throw new Error("Public redirect refused");
            if (!remaining) throw new Error("Too many public redirects");
            if (!URL.canParse(location, target)) throw new Error("Invalid public redirect");
            const next = new URL(location, target);
            const nextHeaders = new Headers(headers);
            if (next.origin !== target.origin)
                for (const name of ["authorization", "proxy-authorization", "cookie", "cookie2", "x-api-key", "x-auth-token", "x-access-token", "signature", "referer", "origin"])
                    nextHeaders.delete(name);
            const nextMethod = (exchange.status === 303 && method !== "HEAD") || ([301, 302].includes(exchange.status) && method === "POST") ? "GET" : method;
            if (nextMethod !== method) for (const name of ["content-type", "content-length", "content-encoding"]) nextHeaders.delete(name);
            return requestUrl(next, remaining - 1, nextMethod, nextHeaders, nextMethod === method ? payload : undefined);
        }
        const responseHeaders = new Headers();
        for (const [name, value] of exchange.headers) responseHeaders.append(name, value);
        const result = new Response(exchange.body, { status: exchange.status, headers: responseHeaders });
        Object.defineProperties(result, {
            url: { value: target.href },
            redirected: { value: target.href !== new URL(url).href },
        });
        return result;
    };
    try {
        return await requestUrl(new URL(url), redirects, (init.method ?? "GET").toUpperCase(), new Headers(init.headers), body);
    } finally {
        clearTimeout(timer);
    }
}
