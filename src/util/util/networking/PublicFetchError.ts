/* SPDX-License-Identifier: AGPL-3.0-only */
export type PublicFetchFailure = "timeout" | "unreachable" | "dns" | "tls" | "proxy" | "other";

export class PublicFetchError extends Error {
    constructor(
        public kind: PublicFetchFailure,
        message: string,
        public cause?: unknown,
    ) {
        super(message);
        this.name = "PublicFetchError";
    }
}

export const publicFetchFailure = (error: unknown): PublicFetchFailure => {
    if (error instanceof PublicFetchError) return error.kind;
    const code = (error as NodeJS.ErrnoException)?.code ?? "";
    const text = String((error as Error)?.message ?? error);
    if (code === "ETIMEDOUT" || /timed out/i.test(text)) return "timeout";
    if (["ENOTFOUND", "EAI_AGAIN", "EAI_NONAME"].includes(code) || /resolves to a forbidden address|has no reachable address/.test(text)) return "dns";
    if (
        ["ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "EHOSTUNREACH", "EADDRNOTAVAIL", "EPIPE"].includes(code) ||
        /could not reach the host|closed early|socket hang up/i.test(text)
    )
        return "unreachable";
    if (/certificate|tls|ssl|self.signed|ERR_TLS/i.test(`${code} ${text}`)) return "tls";
    if (/outbound proxy|PUBLIC_FETCH_PROXY/.test(text)) return "proxy";
    return "other";
};
