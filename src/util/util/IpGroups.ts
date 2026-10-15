/* SPDX-License-Identifier: AGPL-3.0-only */
import { BlockList, isIP } from "node:net";

const MAPPED_V4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

export interface IpGroup {
    key: string;
    family: 4 | 6;
    ip: string;
    pattern: string;
}

export const plainIp = (value: unknown) => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const ip = MAPPED_V4.exec(trimmed)?.[1] ?? trimmed;
    return isIP(ip) ? ip.toLowerCase() : null;
};

export function expandIpv6(value: string) {
    const address = value.split("%")[0].toLowerCase();
    if (isIP(address) !== 6) return null;
    const embedded = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address)?.[1];
    const hex = embedded
        ? (() => {
              const [a, b, c, d] = embedded.split(".").map(Number);
              return `${address.slice(0, -embedded.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
          })()
        : address;
    const [head, tail] = hex.split("::");
    const parse = (part?: string) => (part ? part.split(":").map((group) => Number.parseInt(group, 16)) : []);
    const left = parse(head);
    const right = parse(tail);
    const fill = hex.includes("::") ? 8 - left.length - right.length : 0;
    return [...left, ...new Array<number>(fill).fill(0), ...right];
}

export function ipGroup(value: unknown): IpGroup | null {
    const ip = plainIp(value);
    if (!ip) return null;
    if (isIP(ip) === 4) return { key: ip, family: 4, ip, pattern: ip };
    const groups = expandIpv6(ip);
    if (!groups) return null;
    const network = new URL(`http://[${[...groups.slice(0, 4), 0, 0, 0, 0].map((group) => group.toString(16)).join(":")}]`).hostname.slice(1, -1);
    return {
        key: `${network}/64`,
        family: 6,
        ip,
        pattern: groups[0] ? `${groups[0].toString(16)}:%` : "%:%",
    };
}

export const sameIpGroup = (a: unknown, b: unknown) => {
    const left = ipGroup(a);
    return !!left && left.key === ipGroup(b)?.key;
};

export function parseIpRange(entry: string) {
    const [address, bits, ...rest] = entry.trim().split("/");
    if (rest.length) return null;
    const ip = plainIp(address);
    if (!ip) return null;
    const family = isIP(ip) as 4 | 6;
    const max = family === 4 ? 32 : 128;
    if (bits === undefined) return { ip, family, prefix: max };
    if (!/^\d{1,3}$/.test(bits)) return null;
    const prefix = Number(bits);
    return prefix <= max ? { ip, family, prefix } : null;
}

export function ipRangeMatcher(entries: readonly string[]) {
    const list = new BlockList();
    let count = 0;
    for (const entry of entries) {
        const range = parseIpRange(entry);
        if (!range) continue;
        list.addSubnet(range.ip, range.prefix, range.family === 4 ? "ipv4" : "ipv6");
        count++;
    }
    return (value: unknown) => {
        if (!count) return false;
        const ip = plainIp(value);
        if (!ip) return false;
        return list.check(ip.split("%")[0], isIP(ip) === 4 ? "ipv4" : "ipv6");
    };
}
