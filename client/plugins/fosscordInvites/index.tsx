/* SPDX-License-Identifier: AGPL-3.0-only */
import SettingsPlugin from "@plugins/_core/settings";
import { copyWithToast } from "@utils/discord";
import definePlugin, { IconProps, StartAt } from "@utils/types";
import { RestAPI, showToast, Text, useEffect, useState } from "@webpack/common";

import { FosscordAuthor } from "../fosscordCore/shared";
import { Button, SettingsSection } from "../fosscordCore/ui";
import managedStyle from "./style.css?managed";

type Invite = { code: string; max_uses: number; uses: number; expires_at: string | null; created_at: string; state: "active" | "revoked" | "expired" | "used_up"; joined: number };
type Joined = { user: { id: string; username: string; global_name: string | null }; invite_code: string | null; joined_at: string | null };
type Overview = {
    invite_only: boolean;
    quota: { total: number; used: number; reserved: number; available: number; eligible: boolean; eligible_at: string };
    limits: { max_uses: number; max_age_seconds: number };
    invites: Invite[];
    joined: Joined[];
};
type Lookup = { invite_only: boolean; code: string | null; valid: boolean; inviter: { username: string; global_name: string | null } | null };
type LayoutNode = ReturnType<typeof SettingsPlugin.buildEntry> & { fosscordInvites?: boolean };

const ENTRY_KEY = "fosscord_invites_sidebar_item";
const STORAGE_KEY = "fosscordInstanceInvite";
const PARAM = "instance_invite";
const CODE = /^[A-Za-z0-9]{6,32}$/;
const DURATIONS: [seconds: number, label: string][] = [
    [3600, "1 hour"],
    [86_400, "1 day"],
    [604_800, "7 days"],
    [2_592_000, "30 days"],
];
const STATE_LABELS: Record<Invite["state"], string> = { active: "Active", revoked: "Revoked", expired: "Expired", used_up: "Used up" };

let signupCode = "";

const readStoredCode = () => {
    try {
        return sessionStorage.getItem(STORAGE_KEY) ?? "";
    } catch {
        return "";
    }
};

const storeCode = (code: string) => {
    signupCode = code;
    try {
        if (code) sessionStorage.setItem(STORAGE_KEY, code);
        else sessionStorage.removeItem(STORAGE_KEY);
    } catch {}
};

const inviteLink = (code: string) => `${location.origin}/register?${PARAM}=${encodeURIComponent(code)}`;
const formatDate = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const errorMessage = (error: unknown, fallback: string): string => (error as { body?: { message?: string } } | null)?.body?.message || fallback;

function SignupInvite() {
    const [code, setCode] = useState(signupCode);
    const [lookup, setLookup] = useState<Lookup | null>(null);
    useEffect(() => {
        storeCode(code.trim());
        const timer = setTimeout(
            () => {
                const trimmed = code.trim();
                RestAPI.get({ url: "/auth/instance-invite", query: CODE.test(trimmed) ? { code: trimmed } : {} })
                    .then(({ body }: { body: Lookup }) => setLookup(body))
                    .catch(() => setLookup(null));
            },
            lookup ? 400 : 0,
        );
        return () => clearTimeout(timer);
    }, [code]);
    if (!lookup || (!lookup.invite_only && !code.trim())) return null;
    const trimmed = code.trim();
    const status = !trimmed
        ? "This instance is invite-only. Paste the code from your invite link."
        : !CODE.test(trimmed) || (lookup.code === trimmed && !lookup.valid)
          ? "This invite is invalid, expired or used up. Ask for a new invite link."
          : lookup.code === trimmed && lookup.inviter
            ? `Invited by ${lookup.inviter.global_name || lookup.inviter.username}.`
            : lookup.code === trimmed
              ? "This invite works."
              : "Checking invite…";
    const invalid = !!trimmed && (!CODE.test(trimmed) || (lookup.code === trimmed && !lookup.valid));
    return (
        <section className="fosscord-invite-signup" aria-label="Invite">
            <label className="fosscord-invite-signup-label" htmlFor="fosscord-invite-code">
                Invite code <span>{lookup.invite_only ? "Required" : "Optional"}</span>
            </label>
            <input
                id="fosscord-invite-code"
                className="fosscord-invite-input"
                autoComplete="off"
                spellCheck={false}
                value={code}
                aria-invalid={invalid}
                aria-describedby="fosscord-invite-status"
                onChange={(event) => setCode(event.currentTarget.value)}
                onKeyDown={(event) => {
                    if (event.key === "Enter") event.preventDefault();
                }}
            />
            <p id="fosscord-invite-status" className="fosscord-invite-signup-status" role="status" data-invalid={invalid}>
                {status}
            </p>
        </section>
    );
}

function InvitesPage() {
    const [overview, setOverview] = useState<Overview | null>(null);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const [uses, setUses] = useState(1);
    const [duration, setDuration] = useState(604_800);
    const load = () =>
        RestAPI.get({ url: "/users/@me/instance-invites" })
            .then(({ body }: { body: Overview }) => {
                setOverview(body);
                setError("");
            })
            .catch((failure: unknown) => setError(errorMessage(failure, "Could not load your invites. Reopen this page to try again.")));
    useEffect(() => {
        load();
    }, []);
    if (!overview)
        return (
            <SettingsSection className="fosscord-invites" title="Invites">
                {error ? <p role="alert">{error}</p> : <p role="status">Loading invites…</p>}
            </SettingsSection>
        );
    const { quota, limits } = overview;
    const durations = DURATIONS.filter(([seconds]) => !limits.max_age_seconds || seconds <= limits.max_age_seconds);
    const maxUses = Math.max(1, limits.max_uses);
    const create = async () => {
        setBusy(true);
        setError("");
        try {
            const { body } = await RestAPI.post({ url: "/users/@me/instance-invites", body: { max_uses: Math.min(uses, maxUses), max_age_seconds: duration } });
            await copyWithToast(inviteLink(body.code), "Invite link created and copied.");
            await load();
        } catch (failure) {
            setError(errorMessage(failure, "Could not create the invite. Try again."));
        } finally {
            setBusy(false);
        }
    };
    const revoke = async (invite: Invite) => {
        setBusy(true);
        setError("");
        try {
            await RestAPI.del({ url: `/users/@me/instance-invites/${invite.code}` });
            showToast("Invite revoked.", "success");
            await load();
        } catch (failure) {
            setError(errorMessage(failure, "Could not revoke the invite. Try again."));
        } finally {
            setBusy(false);
        }
    };
    const summary = quota.available
        ? `You can bring in ${quota.available === 1 ? "1 more person" : `${quota.available} more people`}.`
        : !quota.eligible && quota.total === 0
          ? `You can invite people from ${formatDate(quota.eligible_at)}, once your account is old enough.`
          : "You have no invites left. Revoking an unused invite gives it back.";
    return (
        <SettingsSection
            className="fosscord-invites"
            title="Invites"
            description={
                overview.invite_only
                    ? "This instance is invite-only. People can only sign up with an invite link from a member. Each person who joins uses one of your invites."
                    : "Invite links show who brought each person in. Each person who joins uses one of your invites."
            }
        >
            <div className="fosscord-invites-quota" role="status">
                <Text variant="text-md/semibold">{summary}</Text>
                <Text variant="text-sm/normal" color="text-muted">
                    {quota.used} joined, {quota.reserved} waiting on open invites, {quota.total} in total.
                </Text>
            </div>
            {quota.available > 0 && (
                <div className="fosscord-invites-create">
                    <label>
                        <Text variant="text-sm/medium">People who can join</Text>
                        <select className="fosscord-invite-input" value={Math.min(uses, maxUses)} onChange={(event) => setUses(Number(event.currentTarget.value))}>
                            {Array.from({ length: maxUses }, (_, index) => index + 1).map((count) => (
                                <option key={count} value={count}>
                                    {count}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label>
                        <Text variant="text-sm/medium">Expires after</Text>
                        <select className="fosscord-invite-input" value={duration} onChange={(event) => setDuration(Number(event.currentTarget.value))}>
                            {durations.map(([seconds, label]) => (
                                <option key={seconds} value={seconds}>
                                    {label}
                                </option>
                            ))}
                        </select>
                    </label>
                    <Button disabled={busy} onClick={create}>
                        {busy ? "Creating…" : "Create invite link"}
                    </Button>
                </div>
            )}
            {error && <p role="alert">{error}</p>}
            <div className="fosscord-invites-group">
                <Text variant="text-md/semibold">Your invite links</Text>
                {overview.invites.length ? (
                    <ul className="fosscord-invites-list">
                        {overview.invites.map((invite) => (
                            <li key={invite.code} className="fosscord-invite-row" data-state={invite.state}>
                                <div className="fosscord-invite-meta">
                                    <Text variant="text-sm/semibold" className="fosscord-invite-code">
                                        {invite.code}
                                    </Text>
                                    <Text variant="text-xs/normal" color="text-muted">
                                        {STATE_LABELS[invite.state]} · {invite.uses} of {invite.max_uses} used
                                        {invite.expires_at && invite.state === "active" ? ` · expires ${formatDate(invite.expires_at)}` : ""}
                                    </Text>
                                </div>
                                {invite.state === "active" && (
                                    <div className="fosscord-invite-actions">
                                        <Button variant="secondary" onClick={() => copyWithToast(inviteLink(invite.code), "Invite link copied.")}>
                                            Copy link
                                        </Button>
                                        <Button variant="secondary" disabled={busy} onClick={() => revoke(invite)}>
                                            Revoke
                                        </Button>
                                    </div>
                                )}
                            </li>
                        ))}
                    </ul>
                ) : (
                    <Text variant="text-sm/normal" color="text-muted">
                        Links you create show up here. Share one with a person you want to bring in.
                    </Text>
                )}
            </div>
            <div className="fosscord-invites-group">
                <Text variant="text-md/semibold">People you invited</Text>
                {overview.joined.length ? (
                    <ul className="fosscord-invites-list">
                        {overview.joined.map((person) => (
                            <li key={person.user.id} className="fosscord-invite-row">
                                <div className="fosscord-invite-meta">
                                    <Text variant="text-sm/semibold">{person.user.global_name || person.user.username}</Text>
                                    <Text variant="text-xs/normal" color="text-muted">
                                        @{person.user.username}
                                        {person.joined_at ? ` · joined ${formatDate(person.joined_at)}` : ""}
                                        {person.invite_code ? ` · with ${person.invite_code}` : ""}
                                    </Text>
                                </div>
                            </li>
                        ))}
                    </ul>
                ) : (
                    <Text variant="text-sm/normal" color="text-muted">
                        Nobody has joined with your invites yet.
                    </Text>
                )}
            </div>
        </SettingsSection>
    );
}

const InvitesIcon = ({ width = 20, height = 20, className }: IconProps) => (
    <svg
        viewBox="0 0 24 24"
        width={width}
        height={height}
        className={className}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
    >
        <path d="M15 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1" />
        <circle cx="8.5" cy="7" r="3.5" />
        <path d="M19 8v6M22 11h-6" />
    </svg>
);

const insertEntry = (items: LayoutNode[]) => {
    if (!Array.isArray(items) || items.some((item) => item?.key === ENTRY_KEY)) return items;
    const entry = SettingsPlugin.buildEntry({ key: ENTRY_KEY, title: "Invites", panelTitle: "Invites", Component: InvitesPage, Icon: InvitesIcon });
    const anchor = items.findIndex((item) => item?.key === "data_and_privacy_sidebar_item");
    items.splice(anchor === -1 ? items.length : anchor + 1, 0, entry);
    return items;
};

let originalBuildLayout: typeof SettingsPlugin.buildLayout | null = null;

export default definePlugin({
    name: "FosscordInvites",
    description: "Carries instance invite links through signup and adds an Invites page to User Settings.",
    authors: [FosscordAuthor],
    required: true,
    startAt: StartAt.DOMContentLoaded,
    managedStyle,
    renderSignupInvite: () => <SignupInvite key="fosscord-invite-signup" />,
    takeInvite: () => (CODE.test(signupCode) ? signupCode : undefined),
    patches: [
        {
            find: "REGISTER_PROMO_EMAIL_CHECKBOX_WEB",
            replacement: [
                {
                    match: /\(0,\i\.jsx\)\(\i,\{consent:\i,consentRequired:\i,onConsentChange:\i\}\)/g,
                    replace: "$self.renderSignupInvite(),$&",
                },
                {
                    match: /url:\i\.\i\.REGISTER,body:\{/,
                    replace: "$&instance_invite:$self.takeInvite(),",
                },
            ],
        },
    ],
    start() {
        const fromUrl = new URLSearchParams(location.search).get(PARAM)?.trim() ?? "";
        storeCode(CODE.test(fromUrl) ? fromUrl : readStoredCode());
        originalBuildLayout = SettingsPlugin.buildLayout;
        const original = originalBuildLayout;
        SettingsPlugin.buildLayout = function (builder) {
            const layout: LayoutNode[] = original.call(this, builder);
            if (builder.key === "user_section") return insertEntry(layout);
            if (builder.key !== "$Root" || !Array.isArray(layout)) return layout;
            const user = layout.find((node) => node?.key === "user_section");
            if (user?.buildLayout && !user.fosscordInvites) {
                const build = user.buildLayout;
                user.buildLayout = () => insertEntry(build());
                user.fosscordInvites = true;
            }
            return layout;
        };
    },
    stop() {
        if (originalBuildLayout) SettingsPlugin.buildLayout = originalBuildLayout;
        originalBuildLayout = null;
    },
});
