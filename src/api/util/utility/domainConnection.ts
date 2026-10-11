import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import { fetchPublicUrl, JwtKeypairManager } from "@spacebar/util";

export const DomainConnection = {
    normalize(domain: string) {
        const normalized = domain.trim().toLowerCase().replace(/\.$/, "");
        if (normalized.length > 253 || net.isIP(normalized) || !/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(normalized)) return undefined;
        return normalized;
    },

    proof(user_id: string, domain: string) {
        const secret = JwtKeypairManager.keypair.privateKey.export({ format: "pem", type: "sec1" });
        return `dh=${crypto.createHmac("sha256", secret).update(`domain-connection:${user_id}:${domain}`).digest("hex").slice(0, 40)}`;
    },

    async verify(domain: string, proof: string) {
        const records = await dns.resolveTxt(`_discord.${domain}`).catch(() => [] as string[][]);
        if (records.some((parts) => parts.join("").trim() === proof)) return true;

        const res = await fetchPublicUrl(`https://${domain}/.well-known/discord`, { redirect: "error" }, 0, { maxBytes: 4096, timeoutMs: 5000 }).catch(() => undefined);
        if (!res?.ok) return false;
        return (await res.text().catch(() => "")).slice(0, 1024).trim() === proof;
    },
};
