/* SPDX-License-Identifier: AGPL-3.0-only */
import { BlockList, isIP } from "node:net";

const cloudflare = new BlockList();
for (const range of [
    "173.245.48.0/20",
    "103.21.244.0/22",
    "103.22.200.0/22",
    "103.31.4.0/22",
    "141.101.64.0/18",
    "108.162.192.0/18",
    "190.93.240.0/20",
    "188.114.96.0/20",
    "197.234.240.0/22",
    "198.41.128.0/17",
    "162.158.0.0/15",
    "104.16.0.0/13",
    "104.24.0.0/14",
    "172.64.0.0/13",
    "131.0.72.0/22",
]) {
    const [network, prefix] = range.split("/");
    cloudflare.addSubnet(network, Number(prefix), "ipv4");
}
for (const range of ["2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32"]) {
    const [network, prefix] = range.split("/");
    cloudflare.addSubnet(network, Number(prefix), "ipv6");
}

const plain = (address: string) => {
    const trimmed = address.trim();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(trimmed);
    return mapped ? mapped[1] : trimmed;
};

export const DEFAULT_TRUSTED_PROXIES = "loopback, linklocal, uniquelocal";

export function isCloudflareAddress(address: string | undefined | null) {
    if (!address) return false;
    const ip = plain(address);
    const family = isIP(ip);
    return family !== 0 && cloudflare.check(ip, family === 6 ? "ipv6" : "ipv4");
}

export function behindCloudflare<T extends string | undefined | null>(address: T, connectingIp: string | string[] | undefined): T | string {
    if (!isCloudflareAddress(address) || typeof connectingIp !== "string") return address;
    const ip = plain(connectingIp);
    return isIP(ip) ? ip : address;
}

type ClientRequest = { ip?: string; headers: Record<string, string | string[] | undefined>; socket: { remoteAddress?: string }; app: { get(name: string): unknown } };

export function headerAddress(value: string | string[] | undefined) {
    const raw = Array.isArray(value) ? value.at(-1) : value;
    const first = raw?.split(",")[0];
    if (!first) return undefined;
    const ip = plain(first);
    return isIP(ip) ? ip : undefined;
}

export function resolveClientAddress(req: ClientRequest, forwardedFor: string | null | undefined) {
    const header = forwardedFor?.trim().toLowerCase();
    if (header && header !== "x-forwarded-for") {
        const peer = req.socket.remoteAddress;
        const trust = req.app.get("trust proxy fn") as ((address: string, hop: number) => boolean) | undefined;
        const fromProxy = !!peer && (isCloudflareAddress(peer) || !!trust?.(peer, 0));
        return (fromProxy && headerAddress(req.headers[header])) || req.ip;
    }
    return behindCloudflare(req.ip, req.headers["cf-connecting-ip"]);
}

export function useClientAddress(
    app: { set(name: string, value: unknown): unknown; use(handler: (req: never, res: never, next: () => void) => void): unknown },
    security: () => { trustedProxies: string | boolean | null; forwardedFor: string | null },
) {
    app.set("trust proxy", security().trustedProxies || DEFAULT_TRUSTED_PROXIES);
    app.use((req: ClientRequest, _res: unknown, next: () => void) => {
        const ip = resolveClientAddress(req, security().forwardedFor);
        if (ip !== req.ip) Object.defineProperty(req, "ip", { value: ip, configurable: true, enumerable: true });
        next();
    });
}
