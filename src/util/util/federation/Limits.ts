/* SPDX-License-Identifier: AGPL-3.0-only */
import { FEDERATION_HEADERS, FederationRequestError, SIGNED_REQUEST_WINDOW, signedRequestSender } from "./Protocol";

export const RELAY_BODY_LIMIT = 40 * 1024 * 1024;
export const FEDERATION_BODY_LIMIT = 4 * 1024 * 1024;
export const UNVERIFIED_BODY_BUDGET = 128 * 1024 * 1024;

export class ByteBudget {
    #used = 0;

    constructor(private limit: number) {}

    reserve(bytes: number) {
        if (!Number.isSafeInteger(bytes) || bytes < 0 || this.#used + bytes > this.limit) return null;
        this.#used += bytes;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.#used -= bytes;
        };
    }

    get used() {
        return this.#used;
    }
}

const single = (headers: Record<string, string | string[] | undefined>, name: string) => {
    const value = headers[name];
    return Array.isArray(value) ? value[0] : value;
};

export const federationBodyLimit = (path: string) => (/^\/relay\/?$/.test(path) ? RELAY_BODY_LIMIT : FEDERATION_BODY_LIMIT);

export function precheckSignedRequest(headers: Record<string, string | string[] | undefined>, path: string, now = Date.now()) {
    const sender = signedRequestSender(headers);
    const timestamp = single(headers, FEDERATION_HEADERS.timestamp) ?? "";
    if (!/^\d{1,16}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > SIGNED_REQUEST_WINDOW)
        throw new FederationRequestError("bad_timestamp", "Meowcord-Timestamp is missing or more than 5 minutes off");
    if (!/^[A-Za-z0-9_-]{22}$/.test(single(headers, FEDERATION_HEADERS.nonce) ?? "")) throw new FederationRequestError("bad_signature", "Meowcord-Nonce is not 16 bytes");
    if (!/^[A-Za-z0-9_-]{86}$/.test(single(headers, FEDERATION_HEADERS.signature) ?? "")) throw new FederationRequestError("bad_signature", "Meowcord-Signature is not 64 bytes");
    const limit = federationBodyLimit(path);
    const declared = single(headers, "content-length");
    const chunked = /chunked/i.test(single(headers, "transfer-encoding") ?? "");
    if (declared !== undefined && (!/^\d{1,12}$/.test(declared) || Number(declared) > limit)) throw new FederationRequestError("too_large", "The body is too large", 413);
    if (single(headers, "content-encoding") && single(headers, "content-encoding") !== "identity")
        throw new FederationRequestError("bad_request", "Compressed bodies aren't accepted", 415);
    return { sender, limit, reserve: declared !== undefined ? Number(declared) : chunked ? limit : 0 };
}
