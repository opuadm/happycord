/* SPDX-License-Identifier: AGPL-3.0-only */
import type { AutomodSpamAction, AutomodSpamConfiguration } from "../config/types/AutomodConfiguration";

export type SpamRule = "everyone_spam" | "mention_spam" | "flood" | "duplicate" | "link_spam" | "new_account_burst" | "duplicate_attachment" | "dm_spam" | "scam_link";

export const SPAM_RULES: SpamRule[] = ["everyone_spam", "mention_spam", "flood", "duplicate", "link_spam", "new_account_burst", "duplicate_attachment", "dm_spam", "scam_link"];

export type ContactKind = "dm" | "friend";

export interface ContactInput {
    user_id: string;
    target_id: string;
    kind: ContactKind;
    accountCreatedAt: number;
    at?: number;
}

export const SPAM_ACTION_ORDER: AutomodSpamAction[] = ["log", "delete", "timeout", "hold", "suspend", "disable"];

export const strongerSpamAction = (a: AutomodSpamAction, b: AutomodSpamAction) => (SPAM_ACTION_ORDER.indexOf(a) >= SPAM_ACTION_ORDER.indexOf(b) ? a : b);

export function escalateSpamAction(action: AutomodSpamAction): AutomodSpamAction {
    if (action === "disable" || action === "suspend") return action;
    if (action === "timeout" || action === "hold") return "suspend";
    return SPAM_ACTION_ORDER[SPAM_ACTION_ORDER.indexOf(action) + 1];
}

export interface SpamInput {
    id: string;
    user_id: string;
    channel_id: string;
    guild_id?: string | null;
    content?: string | null;
    at?: number;
    accountCreatedAt: number;
    canMentionEveryone: boolean;
    moderator: boolean;
    dm: boolean;
    edit?: boolean;
    attachments?: string[];
    ignoredLinkHosts?: readonly string[];
    knownRecipient?: boolean;
}

export interface SpamMessageRef {
    id: string;
    user_id: string;
    channel_id: string;
    guild_id: string | null;
}

export interface SpamHit {
    rule: SpamRule;
    action: AutomodSpamAction;
    users: string[];
    messages: SpamMessageRef[];
    repeat: boolean;
    detail: Record<string, number>;
    term?: string;
    wouldAction?: AutomodSpamAction;
}

interface UserEntry extends SpamMessageRef {
    at: number;
    edit: boolean;
    everyone: 0 | 1 | 2;
    mentions: number;
    link: boolean;
    invite: boolean;
    exact: string;
    loose: string;
    substantial: boolean;
    dm: boolean;
    knownRecipient: boolean;
    attachments: string[];
}

interface ContactEntry {
    at: number;
    target_id: string;
    kind: ContactKind;
}

interface ContentEntry extends SpamMessageRef {
    at: number;
    accountCreatedAt: number;
}

const DAY = 24 * 60 * 60 * 1000;
const MAX_USER_ENTRIES = 500;
const MAX_CONTENT_ENTRIES = 1000;
const SWEEP_EVERY = 60_000;
const HOUR = 60 * 60 * 1000;

const LINK = /https?:\/\/(?:[^\s/@<>]+@)?([^\s/:?#<>]+)[^\s<>]*/gi;
const INVITE = /(?:discord(?:app)?\.com\/invite|discord\.gg|\/invite)\/[\w-]{2,}/i;
const EVERYONE = /(?<![\p{L}\p{N}_.+-])@(?:everyone|here)(?![\p{L}\p{N}_])/u;
const CODE = /```[\s\S]*?```|`[^`\n]*`/g;

const withoutCode = (content: string) => content.replace(CODE, " ");

export const countSpamMentions = (content: string) => new Set([...withoutCode(content).matchAll(/<@(?:!|&)?(\d+)>/g)].map((match) => match[0].replace("!", ""))).size;

export const hasEveryoneMention = (content: string) => EVERYONE.test(withoutCode(content));

export const hasInviteLink = (content: string) => INVITE.test(content);

export const countLinks = (content: string) => [...content.matchAll(LINK)].length;

const linkHost = (host: string) =>
    host
        .toLowerCase()
        .replace(/^www\./, "")
        .replace(/\.$/, "");

export function withoutIgnoredLinks(content: string, ignored: readonly string[] = []) {
    if (!ignored.length) return content;
    const hosts = ignored.map(linkHost);
    return content.replace(LINK, (link: string, host: string) => {
        const name = linkHost(host);
        return !INVITE.test(link) && hosts.some((entry) => name === entry || name.endsWith(`.${entry}`)) ? " " : link;
    });
}

export function spamFingerprint(content: string | null | undefined) {
    const source = (content ?? "").normalize("NFKC").toLowerCase();
    const bare = !/\p{L}/u.test(source.replace(LINK, " ").replace(/<a?:\w+:\d+>|<(?:@[!&]?|#)\d+>|@(?:everyone|here)/g, " "));
    const text = source
        .replace(/\p{Cf}/gu, "")
        .replace(/<a?:(\w+):\d+>/g, " $1 ")
        .replace(/<(?:@[!&]?|#)\d+>/g, " ")
        .replace(/@(?:everyone|here)/g, " ")
        .replace(LINK, (link: string, host: string) => ` ${linkHost(host)}${bare ? link.slice(link.indexOf(host) + host.length).split("#")[0] : ""} `)
        .replace(/\p{N}+/gu, " ")
        .replace(/[^\p{L}.]+/gu, " ")
        .replace(/\.(?=\s|$)|(?<=\s|^)\./g, " ")
        .replace(/(?<![\p{L}.])\p{L}(?: \p{L}){2,}(?![\p{L}.])/gu, (letters) => letters.replace(/ /g, ""))
        .replace(/(.)\1{2,}/gu, "$1$1")
        .replace(/\s+/g, " ")
        .trim();
    const words = [...new Set(text.split(" ").filter((word) => word.length >= 3))].sort();
    return { exact: text, loose: words.length >= 3 ? words.join(" ") : "" };
}

const looksCoordinated = (group: { users: string[]; messages: SpamMessageRef[] }, plain: boolean) =>
    !plain || new Set(group.messages.map((message) => message.channel_id)).size > 1 || group.messages.length > group.users.length;

export class SpamDetector {
    private users = new Map<string, UserEntry[]>();
    private contents = new Map<string, ContentEntry[]>();
    private contacts = new Map<string, ContactEntry[]>();
    private cooldowns = new Map<string, number>();
    private lastSweep = 0;

    reset() {
        this.users.clear();
        this.contents.clear();
        this.contacts.clear();
        this.cooldowns.clear();
    }

    get size() {
        return { users: this.users.size, contents: this.contents.size, contacts: this.contacts.size, cooldowns: this.cooldowns.size };
    }

    hasContact(user_id: string, kind: ContactKind, target_id: string) {
        return (this.contacts.get(user_id) ?? []).some((entry) => entry.kind === kind && entry.target_id === target_id);
    }

    recentContacts(user_id: string, kind: ContactKind, windowMs: number, now = Date.now()) {
        return new Set((this.contacts.get(user_id) ?? []).filter((entry) => entry.kind === kind && entry.at >= now - windowMs).map((entry) => entry.target_id)).size;
    }

    contact(input: ContactInput, config: AutomodSpamConfiguration): SpamHit[] {
        const now = input.at ?? Date.now();
        this.sweep(now, config);
        const dms = config.dms;
        const entries = (this.contacts.get(input.user_id) ?? []).filter((entry) => entry.at >= now - Math.max(dms.windowSeconds * 1000, HOUR));
        if (!entries.some((entry) => entry.kind === input.kind && entry.target_id === input.target_id)) entries.push({ at: now, target_id: input.target_id, kind: input.kind });
        if (entries.length > MAX_USER_ENTRIES) entries.splice(0, entries.length - MAX_USER_ENTRIES);
        this.contacts.set(input.user_id, entries);
        const age = now - input.accountCreatedAt;
        if (!dms.enabled || (dms.exemptAccountAgeDays > 0 && age >= dms.exemptAccountAgeDays * DAY)) return [];
        const limit = input.kind === "dm" ? dms.openLimit : dms.friendRequestLimit;
        const targets = this.recentContacts(input.user_id, input.kind, dms.windowSeconds * 1000, now);
        if (limit <= 0 || targets < limit) return [];
        return [this.hit("dm_spam", dms.action, [input.user_id], [], input.kind === "dm" ? { dm_opens: targets } : { friend_requests: targets }, now, dms.windowSeconds)];
    }

    recentSameContent(user_id: string, guild_id: string | null | undefined, content: string, windowMs: number, now = Date.now(), except?: string) {
        const { exact } = spamFingerprint(content);
        if (!exact) return 0;
        return (this.users.get(user_id) ?? []).filter(
            (entry) => entry.id !== except && !entry.edit && entry.at >= now - windowMs && (entry.guild_id ?? null) === (guild_id ?? null) && entry.exact === exact,
        ).length;
    }

    forget(user_id: string) {
        this.users.delete(user_id);
    }

    inspect(input: SpamInput, config: AutomodSpamConfiguration): SpamHit[] {
        const now = input.at ?? Date.now();
        this.sweep(now, config);
        const content = withoutIgnoredLinks(input.content ?? "", input.ignoredLinkHosts);
        const age = now - input.accountCreatedAt;
        const exempt = (days: number) => days > 0 && age >= days * DAY;
        const { exact, loose } = spamFingerprint(content);
        const link = countLinks(content) > 0;
        const entry: UserEntry = {
            id: input.id,
            user_id: input.user_id,
            channel_id: input.channel_id,
            guild_id: input.guild_id ?? null,
            at: now,
            edit: !!input.edit,
            everyone: !input.dm && hasEveryoneMention(content) ? (input.canMentionEveryone ? 2 : 1) : 0,
            mentions: countSpamMentions(content),
            link,
            invite: hasInviteLink(content),
            exact,
            loose,
            substantial: link || exact.length > 0,
            dm: input.dm,
            knownRecipient: !!input.knownRecipient,
            attachments: [...new Set(input.attachments ?? [])],
        };

        const horizon = now - this.horizon(config);
        const entries = (this.users.get(input.user_id) ?? []).filter((item) => item.at >= horizon);
        entries.push(entry);
        if (entries.length > MAX_USER_ENTRIES) entries.splice(0, entries.length - MAX_USER_ENTRIES);
        this.users.set(input.user_id, entries);

        const within = (seconds: number) => entries.filter((item) => item.at >= now - seconds * 1000);
        const posts = (seconds: number) => within(seconds).filter((item) => !item.edit);
        const hits: SpamHit[] = [];
        const own = (list: UserEntry[]) => list.map(({ id, user_id, channel_id, guild_id }) => ({ id, user_id, channel_id, guild_id }));

        const everyone = config.everyone;
        if (everyone.enabled && entry.everyone && !exempt(everyone.exemptAccountAgeDays)) {
            if (entry.everyone === 1) {
                const attempts = within(everyone.windowSeconds).filter((item) => item.everyone === 1);
                if (attempts.length >= everyone.unpermittedLimit)
                    hits.push(this.hit("everyone_spam", everyone.action, [input.user_id], own(attempts), { attempts: attempts.length, permitted: 0 }, now, everyone.windowSeconds));
            } else if (!input.moderator) {
                const pings = within(everyone.windowSeconds).filter((item) => item.everyone === 2);
                if (pings.length >= everyone.permittedLimit)
                    hits.push(this.hit("everyone_spam", everyone.action, [input.user_id], own(pings), { attempts: pings.length, permitted: 1 }, now, everyone.windowSeconds));
            }
        }

        const mentions = config.mentions;
        if (mentions.enabled && entry.mentions && !input.moderator && !exempt(mentions.exemptAccountAgeDays)) {
            const recent = within(mentions.windowSeconds).filter((item) => item.mentions);
            const total = recent.reduce((sum, item) => sum + item.mentions, 0);
            if (entry.mentions >= mentions.messageLimit)
                hits.push(
                    this.hit("mention_spam", mentions.action, [input.user_id], own([entry]), { mentions: entry.mentions, window_mentions: total }, now, mentions.windowSeconds),
                );
            else if (total >= mentions.windowLimit)
                hits.push(
                    this.hit("mention_spam", mentions.action, [input.user_id], own(recent), { mentions: entry.mentions, window_mentions: total }, now, mentions.windowSeconds),
                );
        }

        if (entry.edit) return this.finish(hits);

        const flood = config.flood;
        if (flood.enabled && !exempt(flood.exemptAccountAgeDays)) {
            const burst = posts(flood.windowSeconds);
            const spread = entry.dm ? [] : posts(flood.channelWindowSeconds).filter((item) => !item.dm && item.guild_id === entry.guild_id);
            const channels = new Set(spread.map((item) => item.channel_id)).size;
            if (burst.length >= flood.messageLimit)
                hits.push(this.hit("flood", flood.action, [input.user_id], own(burst), { messages: burst.length, channels }, now, flood.windowSeconds));
            else if (!input.moderator && channels >= flood.channelLimit)
                hits.push(this.hit("flood", flood.action, [input.user_id], own(spread), { messages: spread.length, channels }, now, flood.channelWindowSeconds));
        }

        const links = config.links;
        if (links.enabled && (entry.link || entry.invite) && !exempt(links.exemptAccountAgeDays)) {
            const recent = posts(links.windowSeconds);
            const invites = recent.filter((item) => item.invite);
            const linked = recent.filter((item) => item.link || item.invite);
            if (entry.invite && invites.length >= links.inviteLimit)
                hits.push(this.hit("link_spam", links.action, [input.user_id], own(invites), { invites: invites.length, links: linked.length }, now, links.windowSeconds));
            else if (linked.length >= links.linkLimit)
                hits.push(this.hit("link_spam", links.action, [input.user_id], own(linked), { invites: invites.length, links: linked.length }, now, links.windowSeconds));
        }

        const duplicates = config.duplicates;
        const burstConfig = config.burst;
        const keys = [entry.exact && `e:${entry.exact}`, entry.loose && `w:${entry.loose}`].filter(Boolean) as string[];
        const contentWindow = Math.max(duplicates.windowSeconds, burstConfig.windowSeconds) * 1000;
        const groups = keys.map((key) => {
            const list = (this.contents.get(key) ?? []).filter((item) => item.at >= now - contentWindow);
            list.push({ id: entry.id, user_id: entry.user_id, channel_id: entry.channel_id, guild_id: entry.guild_id, at: now, accountCreatedAt: input.accountCreatedAt });
            if (list.length > MAX_CONTENT_ENTRIES) list.splice(0, list.length - MAX_CONTENT_ENTRIES);
            this.contents.set(key, list);
            return list;
        });

        const plain = !entry.link && !entry.invite && !entry.mentions && !entry.everyone;
        const burstHit = burstConfig.enabled && (entry.link || entry.exact.length >= burstConfig.minLength) ? this.burstOf(groups, now, burstConfig, plain) : null;
        if (burstHit)
            hits.push(this.hit("new_account_burst", burstConfig.action, burstHit.users, burstHit.messages, { accounts: burstHit.users.length }, now, burstConfig.windowSeconds));
        else if (duplicates.enabled && (entry.link || entry.exact.length >= duplicates.minLength) && !exempt(duplicates.exemptAccountAgeDays)) {
            const mine = posts(duplicates.windowSeconds).filter((item) => item.exact === entry.exact || (!!entry.loose && item.loose === entry.loose));
            const channels = new Set(mine.map((item) => item.channel_id)).size;
            const best = this.bestGroup(groups, now - duplicates.windowSeconds * 1000, (item) => !this.isOlder(item, now, duplicates.exemptAccountAgeDays));
            if (best.users.length >= duplicates.accountLimit && looksCoordinated(best, plain))
                hits.push(this.hit("duplicate", duplicates.action, best.users, best.messages, { accounts: best.users.length, channels }, now, duplicates.windowSeconds));
            else if (!input.moderator && channels >= duplicates.channelLimit)
                hits.push(this.hit("duplicate", duplicates.action, [input.user_id], own(mine), { accounts: 1, channels }, now, duplicates.windowSeconds));
        }

        const attachments = config.attachments;
        if (attachments.enabled && entry.attachments.length) {
            const window = attachments.windowSeconds;
            const mine = posts(window);
            let worst: { hash: string; channels: number; list: UserEntry[] } | null = null;
            for (const hash of entry.attachments) {
                const list = mine.filter((item) => item.attachments.includes(hash));
                const channels = new Set(list.map((item) => item.channel_id)).size;
                if (!worst || channels > worst.channels) worst = { hash, channels, list };
            }
            const groups = entry.attachments.map((hash) => {
                const key = `h:${hash}`;
                const list = (this.contents.get(key) ?? []).filter((item) => item.at >= now - window * 1000);
                list.push({ id: entry.id, user_id: entry.user_id, channel_id: entry.channel_id, guild_id: entry.guild_id, at: now, accountCreatedAt: input.accountCreatedAt });
                if (list.length > MAX_CONTENT_ENTRIES) list.splice(0, list.length - MAX_CONTENT_ENTRIES);
                this.contents.set(key, list);
                return list;
            });
            const best = this.bestGroup(groups, now - window * 1000, (item) => !this.isOlder(item, now, attachments.exemptAccountAgeDays));
            if (best.users.length >= attachments.accountLimit && best.users.includes(input.user_id))
                hits.push(
                    this.hit("duplicate_attachment", attachments.action, best.users, best.messages, { accounts: best.users.length, channels: worst?.channels ?? 1 }, now, window),
                );
            else if (worst && worst.channels >= attachments.channelLimit && !exempt(attachments.exemptAccountAgeDays))
                hits.push(this.hit("duplicate_attachment", attachments.action, [input.user_id], own(worst.list), { accounts: 1, channels: worst.channels }, now, window));
        }

        const dms = config.dms;
        if (dms.enabled && entry.dm && !entry.knownRecipient && entry.exact.length >= dms.minLength && !exempt(dms.exemptAccountAgeDays)) {
            const same = posts(dms.windowSeconds).filter((item) => item.dm && !item.knownRecipient && item.exact === entry.exact);
            const recipients = new Set(same.map((item) => item.channel_id)).size;
            if (dms.sameContentLimit > 0 && recipients >= dms.sameContentLimit)
                hits.push(this.hit("dm_spam", dms.action, [input.user_id], own(same), { same_dms: recipients }, now, dms.windowSeconds));
        }

        return this.finish(hits);
    }

    private burstOf(groups: ContentEntry[][], now: number, config: AutomodSpamConfiguration["burst"], plain: boolean) {
        if (config.exemptAccountAgeDays <= 0) return null;
        const best = this.bestGroup(groups, now - config.windowSeconds * 1000, (item) => !this.isOlder(item, now, config.exemptAccountAgeDays));
        return best.users.length >= config.accountLimit && looksCoordinated(best, plain) ? best : null;
    }

    private isOlder(item: ContentEntry, now: number, days: number) {
        return days > 0 && now - item.accountCreatedAt >= days * DAY;
    }

    private bestGroup(groups: ContentEntry[][], since: number, counts: (item: ContentEntry) => boolean) {
        let best = { users: [] as string[], messages: [] as SpamMessageRef[] };
        for (const group of groups) {
            const list = group.filter((item) => item.at >= since && counts(item));
            const users = [...new Set(list.map((item) => item.user_id))];
            if (users.length > best.users.length) best = { users, messages: list.map(({ id, user_id, channel_id, guild_id }) => ({ id, user_id, channel_id, guild_id })) };
        }
        return best;
    }

    private hit(
        rule: SpamRule,
        action: AutomodSpamAction,
        users: string[],
        messages: SpamMessageRef[],
        detail: Record<string, number>,
        now: number,
        windowSeconds: number,
    ): SpamHit {
        const fresh = users.filter((user) => (this.cooldowns.get(`${rule}:${user}`) ?? 0) <= now);
        for (const user of fresh) this.cooldowns.set(`${rule}:${user}`, now + windowSeconds * 1000);
        const acted = fresh.length ? fresh : users;
        return {
            rule,
            action,
            users: acted,
            messages: messages.filter((message) => acted.includes(message.user_id)),
            repeat: !fresh.length,
            detail,
        };
    }

    private finish(hits: SpamHit[]) {
        return hits.sort((a, b) => SPAM_ACTION_ORDER.indexOf(b.action) - SPAM_ACTION_ORDER.indexOf(a.action));
    }

    private horizon(config: AutomodSpamConfiguration) {
        return (
            Math.max(
                config.everyone.windowSeconds,
                config.mentions.windowSeconds,
                config.flood.windowSeconds,
                config.flood.channelWindowSeconds,
                config.duplicates.windowSeconds,
                config.links.windowSeconds,
                config.burst.windowSeconds,
                config.attachments.windowSeconds,
                config.dms.windowSeconds,
                1,
            ) * 1000
        );
    }

    private sweep(now: number, config: AutomodSpamConfiguration) {
        if (now - this.lastSweep < SWEEP_EVERY) return;
        this.lastSweep = now;
        const horizon = now - this.horizon(config);
        for (const [key, list] of this.users) if (!list.length || list[list.length - 1].at < horizon) this.users.delete(key);
        for (const [key, list] of this.contents) if (!list.length || list[list.length - 1].at < horizon) this.contents.delete(key);
        const contactHorizon = now - Math.max(config.dms.windowSeconds * 1000, HOUR);
        for (const [key, list] of this.contacts) if (!list.length || list[list.length - 1].at < contactHorizon) this.contacts.delete(key);
        for (const [key, until] of this.cooldowns) if (until <= now) this.cooldowns.delete(key);
    }
}
