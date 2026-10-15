/* SPDX-License-Identifier: AGPL-3.0-only */
import type { AutomodQuarantineConfiguration } from "../config/types/AutomodConfiguration";
import { countSpamMentions, hasEveryoneMention } from "./SpamDetector";
import { extractLinks } from "./ScamLinks";

export type QuarantineReason = "links" | "attachments" | "embeds" | "mentions" | "dms";

export interface QuarantineContent {
    content?: string | null;
    attachments?: number;
    embeds?: number;
    ownHosts?: string[];
}

const HOUR = 60 * 60 * 1000;

export function quarantineEndsAt(accountCreatedAt: number, config: Pick<AutomodQuarantineConfiguration, "enabled" | "hours">, now = Date.now()) {
    if (!config.enabled || config.hours <= 0) return null;
    const ends = accountCreatedAt + config.hours * HOUR;
    return ends > now ? ends : null;
}

export function quarantineViolation(message: QuarantineContent, config: AutomodQuarantineConfiguration): QuarantineReason | null {
    const content = message.content ?? "";
    const own = (message.ownHosts ?? []).map((host) => host.toLowerCase());
    if (!config.allowLinks && extractLinks(content).some((link) => !own.some((host) => link.host === host || link.host.endsWith(`.${host}`)))) return "links";
    if (!config.allowAttachments && (message.attachments ?? 0) > 0) return "attachments";
    if (!config.allowEmbeds && (message.embeds ?? 0) > 0) return "embeds";
    if (hasEveryoneMention(content) || countSpamMentions(content) > Math.max(0, config.maxMentions)) return "mentions";
    return null;
}

export function quarantineMessage(reason: QuarantineReason, config: AutomodQuarantineConfiguration, endsAt: number) {
    const until = new Date(endsAt).toUTCString();
    const what =
        reason === "links"
            ? "post links"
            : reason === "attachments"
              ? "upload files"
              : reason === "embeds"
                ? "send embeds"
                : reason === "mentions"
                  ? `mention more than ${config.maxMentions} ${config.maxMentions === 1 ? "person" : "people"} or use @everyone`
                  : `start more than ${config.maxDms} new direct message${config.maxDms === 1 ? "" : "s"}`;
    return `New accounts on this instance can't ${what} for their first ${config.hours} hours. This lifts on ${until}, or sooner if a moderator clears your account.`;
}
