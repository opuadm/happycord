/* SPDX-License-Identifier: AGPL-3.0-only */
import { In } from "typeorm";
import { AutomodAction, AutomodAppeal, type AutomodAppealRestriction, User } from "@spacebar/database";
import { AccountStandingState, UserFlags } from "@spacebar/schemas";
import { reverseAutomodAction } from "./instanceAutomod";

export const APPEAL_MESSAGE_LIMIT = 1000;

const RULE_REASONS: Record<string, string> = {
    hard_r: "a slur in a message or name",
    soft_a: "a slur in a message or name",
    word: "a word on one of the instance's blocked word lists",
    name_blocklist: "a name on the instance's blocked name list",
    ip_limit: "too many signups from your network in one day",
    ip_account_limit: "too many accounts from your network",
    everyone_spam: "pinging @everyone or @here too often",
    mention_spam: "mentioning too many people at once",
    flood: "sending too many messages too fast",
    duplicate: "posting the same message in several places",
    link_spam: "posting many links from a new account",
    new_account_burst: "several new accounts posting the same thing at the same time",
    join_raid: "joining as part of a raid",
    mention_raid: "mention spam as part of a raid",
    dm_raid: "messaging many server members as part of a raid",
    scam_link: "posting a known scam link",
    duplicate_attachment: "posting the same file repeatedly",
    dm_spam: "sending the same direct message to many people",
    signup_bot: "a signup that looked automated",
    quarantine: "posting links or invites while new",
    verification_level: "a server's verification rules",
    explicit_content: "the explicit content filter",
};

const ACTIONS_FOR: Record<AutomodAppealRestriction, string[]> = {
    held: ["hold"],
    suspended: ["suspend", "federation_block"],
    disabled: ["disable", "federation_block"],
};

export interface AppealSubject {
    id: string;
    username?: string | null;
    join_status?: string | null;
    suspended_until?: Date | string | null;
    disabled?: boolean | null;
    flags?: number | string | bigint | null;
    account_standing?: number | null;
}

export const appealRestrictionOf = (user: AppealSubject, now = Date.now()): AutomodAppealRestriction | null => {
    if (user.join_status === "pending") return "held";
    if (user.suspended_until && new Date(user.suspended_until).getTime() > now) return "suspended";
    if (user.account_standing === AccountStandingState.SUSPENDED || (user.disabled && (BigInt(user.flags ?? 0) & UserFlags.FLAGS.DISABLED) !== 0n)) return "disabled";
    return null;
};

export const describeRestriction = (restriction: AutomodAppealRestriction, rule: string | null | undefined, at?: Date | null) => {
    const when = at ? ` on ${new Date(at).toUTCString()}` : "";
    const what = restriction === "held" ? "held for review" : restriction;
    if (rule && RULE_REASONS[rule]) return `Automod ${what === "held for review" ? "held this account for review" : `${what} this account`}${when} for ${RULE_REASONS[rule]}.`;
    if (restriction === "held") return "New accounts on this instance wait for a moderator to approve them.";
    return `A moderator ${what} this account${when}.`;
};

export async function appealState(user: AppealSubject) {
    const restriction = appealRestrictionOf(user);
    if (!restriction) return { restricted: false as const };
    const action = await AutomodAction.findOne({
        where: { user_id: user.id, action: In(ACTIONS_FOR[restriction]), reversed: false },
        order: { created_at: "DESC" },
        select: { id: true, rule: true, created_at: true, action: true },
    });
    const untilKey = restriction === "suspended" && user.suspended_until ? new Date(user.suspended_until).getTime() : "manual";
    const restriction_key = `${restriction}:${action?.id ?? untilKey}`;
    const appeal = await AutomodAppeal.findOne({ where: { user_id: user.id, restriction_key } });
    return {
        restricted: true as const,
        restriction,
        restriction_key,
        action,
        reason: describeRestriction(restriction, action?.rule, action?.created_at),
        until: restriction === "suspended" && user.suspended_until ? new Date(user.suspended_until).toISOString() : null,
        appeal,
    };
}

export const publicAppealState = (state: Awaited<ReturnType<typeof appealState>>) =>
    state.restricted
        ? {
              restricted: true,
              restriction: state.restriction,
              reason: state.reason,
              until: state.until,
              can_appeal: !state.appeal,
              appeal: state.appeal ? { status: state.appeal.status, created_at: state.appeal.created_at, message: state.appeal.message } : null,
          }
        : { restricted: false, can_appeal: false, appeal: null };

export async function submitAppeal(user: AppealSubject, message: string) {
    const state = await appealState(user);
    if (!state.restricted) return { state, created: false };
    if (state.appeal) return { state, created: false };
    const appeal = AutomodAppeal.create({
        user_id: user.id,
        username: user.username ?? null,
        restriction: state.restriction,
        restriction_key: state.restriction_key,
        action_id: state.action?.id ?? null,
        rule: state.action?.rule ?? null,
        reason: state.reason,
        message: message.trim().slice(0, APPEAL_MESSAGE_LIMIT),
    });
    const saved = await appeal.save().catch(() => null);
    return { state: { ...state, appeal: saved ?? (await AutomodAppeal.findOne({ where: { user_id: user.id, restriction_key: state.restriction_key } })) }, created: !!saved };
}

export async function resolveAutomodAppeal(appeal: AutomodAppeal, accepted: boolean, staff_id: string) {
    const claimed = await AutomodAppeal.update({ id: appeal.id, status: "pending" }, { status: accepted ? "accepted" : "denied", resolved_at: new Date(), resolved_by: staff_id });
    if (!claimed.affected) return false;
    if (!accepted) return true;
    const action = appeal.action_id ? await AutomodAction.findOne({ where: { id: appeal.action_id } }) : null;
    if (action && !action.reversed) await reverseAutomodAction(action, staff_id, "false_positive");
    if (appeal.restriction === "held") await User.update({ id: appeal.user_id, join_status: "pending" }, { join_status: "approved" });
    if (appeal.restriction === "suspended") await User.update({ id: appeal.user_id }, { suspended_until: null });
    if (appeal.restriction === "disabled")
        await User.update({ id: appeal.user_id }, { disabled: false, account_standing: null, flags: () => `flags & ~${UserFlags.FLAGS.DISABLED}` });
    return true;
}
