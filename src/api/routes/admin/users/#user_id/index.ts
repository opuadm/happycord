import { assertIdentityNameAllowed } from "@spacebar/util/util/IdentityModeration";
import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { Badge, FederatedObject, Guild, InstanceBan, Member, Session, User } from "@spacebar/database";
import { broadcastUserUpdate, Collectibles, CollectibleItemType, Config, emitEvent, emitRequiredAction, FieldErrors, handleFile, Rights, UserUpdateEvent } from "@spacebar/util";
import type { RightString } from "@spacebar/util";
import { AccountStandingState, AdminUserUpdateSchema, PrivateUserProjection } from "@spacebar/schemas";
import { In, Not } from "typeorm";
import {
    Pomelo,
    resolveProfileCollectibles,
    currentStanding,
    endUserSessions,
    hasAdminPanelAccess,
    listIps,
    normalizeIp,
    notifyStandingDrop,
    syncStaffBadge,
    withStaffDisabled,
} from "@spacebar/api/util";
import { assertShadowUserEditable, SHADOW_USER_LOCAL_FIELDS } from "@spacebar/api/util/utility/federatedAdmin";
import { ADMIN_USER_COLUMNS, applyUserTag, assertCanManage, pickAdminUser } from "../index";

const router = Router({ mergeParams: true });

export const ADMIN_USER_FIELD_RIGHTS: Record<string, RightString> = {
    disabled: "MODERATE_USERS",
    suspended_until: "MODERATE_USERS",
    account_standing: "MODERATE_USERS",
    join_status: "MODERATE_USERS",
    verified: "SUPPORT_USERS",
    rights: "OPERATOR",
};

const loadUser = (id: string) =>
    User.findOneOrFail({
        where: { id },
        select: Object.fromEntries(
            [
                ...ADMIN_USER_COLUMNS,
                "bio",
                "premium_since",
                "pronouns",
                "banner",
                "accent_color",
                "theme_colors",
                "profile_collectibles",
                "collectibles",
                "avatar_decoration_data",
                "avatar_decoration_id",
            ].map((c) => [c, true]),
        ),
    });

router.get(
    "/",
    route({
        right: "VIEW_USERS",
        spacebarOnly: true,
        description: "Get a user with their servers, session count and instance bans",
    }),
    async (req: Request, res: Response) => {
        const user = await loadUser(req.params.user_id as string);

        const memberships = await Member.find({
            where: { id: user.id },
            select: { guild_id: true, joined_at: true },
        });
        const guilds = memberships.length
            ? await Guild.find({
                  where: { id: In(memberships.map((m) => m.guild_id)) },
                  select: { id: true, name: true, icon: true, owner_id: true },
              })
            : [];
        const [sessions, bans, registration, federated] = await Promise.all([
            Session.find({ where: { user_id: user.id }, select: { session_id: true, last_seen_ip: true, last_seen: true, created_at: true } }),
            InstanceBan.find({ where: { user_id: user.id } }),
            User.findOne({ where: { id: user.id }, select: { id: true, registration_ip: true } }),
            user.federated_instance ? FederatedObject.findOne({ where: { local_id: user.id }, select: { local_id: true, canonical: true } }) : null,
        ]);
        const registrationIp = normalizeIp(registration?.registration_ip);
        const seen = new Map<string, { ip: string; sessions: number; last_seen: Date | null; registration: boolean }>();
        if (registrationIp) seen.set(registrationIp, { ip: registrationIp, sessions: 0, last_seen: user.created_at ?? null, registration: true });
        for (const session of sessions) {
            const ip = normalizeIp(session.last_seen_ip);
            if (!ip) continue;
            const at = session.last_seen ?? session.created_at ?? null;
            const entry = seen.get(ip) ?? { ip, sessions: 0, last_seen: null, registration: false };
            entry.sessions++;
            if (at && (!entry.last_seen || at > entry.last_seen)) entry.last_seen = at;
            seen.set(ip, entry);
        }
        const accounts = await listIps({ ips: [...seen.keys()], limit: 100, offset: 0 });
        const byIp = new Map(accounts.ips.map((row) => [row.ip, row]));

        res.json({
            ...pickAdminUser(user),
            bio: user.bio,
            premium_since: user.premium_since ?? null,
            pronouns: user.pronouns ?? "",
            banner: user.banner ?? null,
            accent_color: user.accent_color ?? null,
            theme_colors: user.theme_colors ?? null,
            avatar_decoration_sku_id: user.avatar_decoration_data?.sku_id ?? user.avatar_decoration_id ?? null,
            nameplate_sku_id: user.collectibles?.nameplate?.sku_id ?? null,
            collectibles_sku_ids: (user.profile_collectibles ?? []).map((item) => item.sku_id),
            profile_collectibles: user.profile_collectibles ?? [],
            guilds: guilds.map((g) => ({
                id: g.id,
                name: g.name,
                icon: g.icon ?? null,
                owner: g.owner_id === user.id,
            })),
            session_count: sessions.length,
            registration_ip: registrationIp,
            ips: [...seen.values()]
                .sort((a, b) => (b.last_seen?.getTime() ?? 0) - (a.last_seen?.getTime() ?? 0))
                .map((entry) => ({
                    ...entry,
                    accounts: byIp.get(entry.ip)?.accounts ?? 1,
                    ban_id: byIp.get(entry.ip)?.ban_id ?? null,
                })),
            instance_bans: bans.map((b) => ({ id: b.id, reason: b.reason, created_at: b.created_at, spread: b.is_from_other_instance_ban, ip: b.ip_address ?? null })),
            canonical: federated?.canonical ?? null,
        });
    },
);

router.patch(
    "/",
    route({
        right: "VIEW_USERS",
        spacebarOnly: true,
        requestBody: "AdminUserUpdateSchema",
        description:
            "Edit a user. Profile fields need MANAGE_USERS, `disabled`, `suspended_until`, `account_standing` and `join_status` need MODERATE_USERS, `verified` needs SUPPORT_USERS and `rights` needs OPERATOR. Staff at or above your own role can't be edited.",
    }),
    async (req: Request, res: Response) => {
        const body = req.body as AdminUserUpdateSchema;
        const missing = [...new Set(Object.keys(body).map((field) => ADMIN_USER_FIELD_RIGHTS[field] ?? "MANAGE_USERS"))].filter((right) => !req.rights.has(right));
        if (missing.length) throw new HTTPError(`You are missing the following rights ${missing.join(", ")}`, 403);
        const user = await loadUser(req.params.user_id as string);
        const callerIsOperator = req.rights.has("OPERATOR");
        const targetIsOperator = new Rights(user.rights).has("OPERATOR");
        const isSelf = user.id === req.user_id;
        const hadAdminAccess = hasAdminPanelAccess(user.rights);

        if (targetIsOperator && !callerIsOperator && !isSelf) throw new HTTPError("Only operators can edit other operators", 403);
        assertCanManage(req, user);
        assertShadowUserEditable(
            user,
            Object.keys(body).filter((key) => body[key as keyof AdminUserUpdateSchema] !== undefined),
            SHADOW_USER_LOCAL_FIELDS,
        );
        if (isSelf && (body.disabled || body.account_standing === AccountStandingState.SUSPENDED)) throw new HTTPError("You can't disable or suspend your own account", 400);

        // only some columns are loaded, and the entity has class-level defaults (system, mfa_enabled, ...) for the rest,
        // so save() would write those defaults over the real values. Only the columns this request changes get written
        if (body.username !== undefined && body.username.trim() !== user.username) assertIdentityNameAllowed(body.username);
        assertIdentityNameAllowed(body.global_name, "global_name");

        const changed = new Set<keyof User>();

        if (body.rights !== undefined) {
            if (!callerIsOperator) throw new HTTPError("Only operators can change rights", 403);
            if (!/^\d+$/.test(body.rights)) throw new HTTPError("rights must be a decimal bitfield string", 400);
            if (isSelf && !new Rights(body.rights).has("OPERATOR")) throw new HTTPError("You can't remove OPERATOR from yourself", 400);
            user.rights = body.rights;
            changed.add("rights");
        }

        const set = <K extends keyof User>(key: K, value: User[K]) => {
            user[key] = value;
            changed.add(key);
        };

        if (body.hide_premium_badge !== undefined) set("hide_premium_badge", body.hide_premium_badge);
        const standingBefore = body.account_standing !== undefined ? await currentStanding(user.id) : null;
        if (body.account_standing !== undefined) set("account_standing", body.account_standing);
        if (body.tag !== undefined) {
            applyUserTag(user, body.tag);
            changed.add("public_flags").add("flags");
        }
        if (body.badge_ids !== undefined) {
            const ids = [...new Set(body.badge_ids)];
            const known = ids.length ? await Badge.find({ where: { id: In(ids) }, select: { id: true } }) : [];
            const unknown = ids.filter((id) => !known.some((b) => b.id === id));
            if (unknown.length) throw new HTTPError(`Unknown badge: ${unknown.join(", ")}`, 400);
            set("badge_ids", ids);
        }
        if (body.username !== undefined && body.username.trim() !== user.username) {
            const username = body.username.trim();
            const { maxUsername } = Config.get().limits.user;
            if (username.length < 2 || username.length > maxUsername)
                throw FieldErrors({
                    username: {
                        code: "BASE_TYPE_BAD_LENGTH",
                        message: `Must be between 2 and ${maxUsername} in length.`,
                    },
                });
            if (!user.bot) User.assertUsernameAllowed(username);
            if (user.discriminator === "0") Pomelo.validate(username);
            if (
                await User.exists({
                    where: { username, discriminator: user.discriminator, id: Not(user.id) },
                })
            )
                throw new HTTPError("This username is already in use", 400);
            set("username", username);
        }
        if (body.avatar_decoration_sku_id !== undefined) {
            const item = body.avatar_decoration_sku_id ? await Collectibles.item(body.avatar_decoration_sku_id, CollectibleItemType.AVATAR_DECORATION) : null;
            if (body.avatar_decoration_sku_id && !item?.asset) throw new HTTPError("Choose an existing avatar decoration", 400);
            set("avatar_decoration_id", undefined);
            set("avatar_decoration_data", item ? { asset: item.asset!, sku_id: item.sku_id, expires_at: null } : undefined);
        }
        if (body.nameplate_sku_id !== undefined) {
            const item = body.nameplate_sku_id ? await Collectibles.item(body.nameplate_sku_id, CollectibleItemType.NAMEPLATE) : null;
            if (body.nameplate_sku_id && !item?.asset) throw new HTTPError("Choose an existing nameplate", 400);
            set("collectibles", {
                ...user.collectibles,
                nameplate: item
                    ? {
                          sku_id: item.sku_id,
                          asset: item.asset!,
                          label: item.label ?? "",
                          palette: item.palette ?? "",
                          expires_at: null,
                      }
                    : null,
            });
        }
        if (body.collectibles_sku_ids && body.collectibles_sku_ids.length > 2) throw new HTTPError("Choose at most one profile effect and one frame", 400);
        if (body.collectibles_sku_ids !== undefined) set("profile_collectibles", await resolveProfileCollectibles(user.profile_collectibles, body.collectibles_sku_ids));
        if (body.pronouns !== undefined) {
            const { maxPronouns } = Config.get().limits.user;
            if (body.pronouns && body.pronouns.length > maxPronouns)
                throw FieldErrors({
                    pronouns: {
                        code: "PRONOUNS_INVALID",
                        message: `Pronouns must be less than ${maxPronouns} in length`,
                    },
                });
            set("pronouns", body.pronouns);
        }
        if (body.accent_color !== undefined) set("accent_color", body.accent_color ?? undefined);
        if (body.theme_colors !== undefined) {
            if (body.theme_colors && (body.theme_colors.length !== 2 || body.theme_colors.some((color) => !Number.isInteger(color) || color < 0 || color > 16777215)))
                throw new HTTPError("Theme colors must be integers between 0 and 16777215", 400);
            set("theme_colors", body.theme_colors ?? undefined);
        }
        for (const field of ["avatar", "banner"] as const) {
            if (body[field] !== undefined) set(field, body[field] ? await handleFile(`/${field}s/${user.id}`, body[field]!) : undefined);
        }
        if (body.global_name !== undefined) {
            const { maxUsername } = Config.get().limits.user;
            const global_name = body.global_name?.trim() || null;
            if (global_name && global_name.length > maxUsername)
                throw FieldErrors({
                    global_name: {
                        code: "BASE_TYPE_BAD_LENGTH",
                        message: `Must be ${maxUsername} or fewer in length.`,
                    },
                });
            set("global_name", global_name);
        }
        if (body.bio !== undefined) {
            const { maxBio } = Config.get().limits.user;
            if (body.bio && body.bio.length > maxBio)
                throw FieldErrors({
                    bio: {
                        code: "BIO_INVALID",
                        message: `Bio must be less than ${maxBio} in length`,
                    },
                });
            set("bio", body.bio);
        }
        if (body.disabled !== undefined) {
            set("disabled", body.disabled);
            set("flags", withStaffDisabled(user.flags, body.disabled));
        }
        if (body.suspended_until !== undefined) {
            const until = body.suspended_until === null ? null : new Date(body.suspended_until);
            if (until && (Number.isNaN(until.getTime()) || isSelf)) throw new HTTPError("Choose a valid suspension end, and don't suspend yourself", 400);
            set("suspended_until", until);
        }
        if (body.join_status !== undefined) set("join_status", body.join_status);
        if (body.verified !== undefined) set("verified", body.verified);
        if (body.premium_type !== undefined) {
            if (body.premium_type > 0 && !user.premium_type) set("premium_since", new Date());
            set("premium_type", body.premium_type);
            set("premium", body.premium_type > 0);
        }

        if (body.rights !== undefined) {
            await syncStaffBadge(user, hadAdminAccess);
            changed.add("badge_ids");
        }

        if (changed.size) await User.update({ id: user.id }, Object.fromEntries([...changed].map((key) => [key, user[key] ?? null])));

        if (
            user.disabled ||
            user.account_standing === AccountStandingState.SUSPENDED ||
            (user.suspended_until && new Date(user.suspended_until).getTime() > Date.now()) ||
            user.join_status === "rejected"
        )
            await endUserSessions([user.id], "Account suspended");

        if (standingBefore !== null) await notifyStandingDrop(user.id, standingBefore, await currentStanding(user.id));

        const updated = await User.findOneOrFail({
            where: { id: user.id },
            select: Object.fromEntries(PrivateUserProjection.map((i) => [i, true])),
        });
        await emitEvent({
            event: "USER_UPDATE",
            user_id: user.id,
            data: updated,
        } satisfies UserUpdateEvent);

        if (changed.has("verified")) await emitRequiredAction(user.id);
        if (changed.size) await broadcastUserUpdate(user.id);
        res.json(pickAdminUser(await loadUser(user.id)));
    },
);

export default router;
