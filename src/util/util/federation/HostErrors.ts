/* SPDX-License-Identifier: AGPL-3.0-only */
import { ApiError } from "../ApiError";
import { PublicFetchError, publicFetchFailure } from "../networking/PublicFetchError";
import { FederationRequestError } from "./Protocol";

const OLD_UNKNOWN_SENDER = /doesn't federate with the sender/i;

export const describeHostFailure = (instance: string, error: unknown) => {
    if (error instanceof FederationRequestError) return error;
    const kind = publicFetchFailure(error);
    const detail = String((error as Error)?.message ?? error);
    if (kind === "timeout") return new FederationRequestError("host_timeout", `${instance} didn't answer in time. It may be down or overloaded, so try again later.`, 504);
    if (kind === "proxy") return new FederationRequestError("proxy_error", `This instance couldn't send the request to ${instance} through its outbound proxy: ${detail}`, 502);
    if (kind === "tls") return new FederationRequestError("host_unreachable", `${instance} has a broken HTTPS setup: ${detail}`, 502);
    if (kind === "dns" || kind === "unreachable")
        return new FederationRequestError("host_unreachable", `Couldn't reach ${instance}. It may be down, so try again later. (${detail})`, 502);
    if (!(error instanceof PublicFetchError)) console.warn(`[Federation] Request to ${instance} failed:`, error);
    return new FederationRequestError("host_unreachable", `Couldn't reach ${instance}: ${detail}`, 502);
};

export const describeHostAnswer = (instance: string, status: number, body: unknown, own: string | null) => {
    const raw = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const clientStatus = status === 401 ? 403 : status === 429 ? 429 : status >= 500 || status < 400 ? 502 : status;
    if (typeof raw.code === "string" && typeof raw.error === "string") {
        if (raw.code === "not_federated" && OLD_UNKNOWN_SENDER.test(raw.error))
            return new FederationRequestError(
                "unknown_sender",
                `${instance} doesn't accept requests from ${own ?? "this instance"} yet. Its copy of the registry list may be older than this instance's approval, since instances fetch it every 5 minutes, or its admins may have blocked this instance. Try again in a few minutes.`,
                403,
            );
        return new FederationRequestError(raw.code, raw.error, clientStatus);
    }
    const message = typeof raw.message === "string" && raw.message.trim() ? raw.message : null;
    if (message && status >= 400 && status < 500)
        return typeof raw.code === "number" && Number.isSafeInteger(raw.code)
            ? new ApiError(message, raw.code, clientStatus)
            : new FederationRequestError(`host_${status}`, message, clientStatus);
    if (typeof raw.raw === "string")
        return new FederationRequestError(
            "host_bad_response",
            `${instance} answered HTTP ${status} with a page instead of a Meowcord response. It may be down, updating, or behind a misconfigured proxy.`,
            502,
        );
    return new FederationRequestError("host_error", `${instance} answered HTTP ${status}${message ? `: ${message}` : ""}. Try again later.`, 502);
};
