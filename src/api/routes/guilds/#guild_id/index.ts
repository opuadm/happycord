import { Request, Response, Router } from "express";
import { In } from "typeorm";
import { route } from "@spacebar/api/middlewares";
import { AuditLog, Channel, Guild, Member } from "@spacebar/database";
import { ApiError, DiscordApiErrors, FieldErrors, GuildUpdateEvent, Permissions, emitEvent, getPermission, getRights, handleFile } from "@spacebar/util";
import { AuditLogEvents, GuildCreateResponse, GuildUpdateSchema } from "@spacebar/schemas";
import { bulkActionJoinRequests, enforceNameAutomod, isApplyGuild, noteRightsBypass } from "@spacebar/api/util";
import { reindexDiscoverySoon } from "@spacebar/api/util/handlers/Discovery";

const router = Router({ mergeParams: true });

router.get(
    "/",
    route({
        responses: {
            "200": {
                body: "APIGuildWithJoinedAt",
            },
            403: {
                body: "APIErrorResponse",
            },
            404: {
                body: "APIErrorResponse",
            },
        },
    }),
    async (req: Request, res: Response) => {
        const { guild_id } = req.params as { [key: string]: string };

        const [guild, member] = await Promise.all([Guild.findOneOrFail({ where: { id: guild_id } }), Member.findOne({ where: { guild_id: guild_id, id: req.user_id } })]);
        if (!member) throw new ApiError("Missing Access", 50001, 403);

        return res.send({
            ...guild.toJSON(),
            joined_at: member?.joined_at,
        });
    },
);

router.patch(
    "/",
    route({
        requestBody: "GuildUpdateSchema",
        permission: "MANAGE_GUILD",
        responses: {
            200: {
                body: "GuildCreateResponse",
            },
            401: {
                body: "APIErrorResponse",
            },
            403: {
                body: "APIErrorResponse",
            },
            404: {
                body: "APIErrorResponse",
            },
        },
    }),
    async (req: Request, res: Response) => {
        const body = req.body as GuildUpdateSchema;
        const { guild_id } = req.params as { [key: string]: string };

        const rights = await getRights(req.user_id);
        const permission = await getPermission(req.user_id, guild_id);

        if (!rights.has("MANAGE_GUILDS") && !permission.has("MANAGE_GUILD")) throw DiscordApiErrors.MISSING_PERMISSIONS.withParams("MANAGE_GUILDS");
        if (!permission.has("MANAGE_GUILD")) await noteRightsBypass(req, "MANAGE_GUILDS");
        if (body.name !== undefined) await enforceNameAutomod({ user_id: req.user_id, name: body.name, field: "name", source: "guild_name", guild_id });

        const guild = await Guild.findOneOrFail({
            where: { id: guild_id },
            relations: { emojis: true, roles: true, stickers: true },
        });

        if (body.owner_id !== undefined) {
            if (guild.owner_id !== req.user_id) throw DiscordApiErrors.MISSING_PERMISSIONS;
            const member = await Member.findOne({
                where: { guild_id, id: body.owner_id },
                relations: { user: true },
            });
            if (!member) throw DiscordApiErrors.UNKNOWN_MEMBER;
            if (member.user.bot)
                throw FieldErrors({
                    owner_id: { code: "BASE_TYPE_INVALID", message: "Cannot transfer ownership to a bot." },
                });
        }

        // trying to `select` this fails
        guild.channel_ordering = (
            await Guild.findOneOrFail({
                where: { id: guild_id },
                select: { channel_ordering: true },
            })
        ).channel_ordering;

        const auditKeys = [
            "name",
            "description",
            "icon",
            "splash",
            "discovery_splash",
            "banner",
            "owner_id",
            "region",
            "preferred_locale",
            "afk_channel_id",
            "afk_timeout",
            "rules_channel_id",
            "public_updates_channel_id",
            "safety_alerts_channel_id",
            "mfa_level",
            "verification_level",
            "explicit_content_filter",
            "default_message_notifications",
            "system_channel_id",
            "system_channel_flags",
            "premium_progress_bar_enabled",
            "widget_enabled",
            "widget_channel_id",
            "nsfw_level",
        ];
        const auditBefore = Object.fromEntries(auditKeys.map((key) => [key, (guild as unknown as Record<string, unknown>)[key]]));

        // TODO: guild update check image

        if (body.icon && body.icon != guild.icon) body.icon = await handleFile(`/icons/${guild_id}`, body.icon);

        if (body.banner && body.banner !== guild.banner) body.banner = await handleFile(`/banners/${guild_id}`, body.banner);

        if (body.splash && body.splash !== guild.splash) body.splash = await handleFile(`/splashes/${guild_id}`, body.splash);

        if (body.discovery_splash && body.discovery_splash !== guild.discovery_splash)
            body.discovery_splash = await handleFile(`/discovery-splashes/${guild_id}`, body.discovery_splash);

        const wasApply = isApplyGuild(guild.features);
        if (body.features) {
            const MUTABLE_FEATURES = [
                "COMMUNITY",
                "INVITES_DISABLED",
                "DISCOVERABLE",
                "RAID_ALERTS_DISABLED",
                "NON_COMMUNITY_RAID_ALERTS",
                "MEMBER_VERIFICATION_GATE_ENABLED",
                "MEMBER_VERIFICATION_MANUAL_APPROVAL",
                "PREVIEW_ENABLED",
                "NEWS",
                "WELCOME_SCREEN_ENABLED",
                "GUILD_ONBOARDING",
                "GUILD_ONBOARDING_EVER_ENABLED",
                "GUILD_ONBOARDING_HAS_PROMPTS",
                "GUILD_SERVER_GUIDE",
                "ACTIVITY_FEED_DISABLED_BY_USER",
                "ACTIVITY_FEED_ENABLED_BY_USER",
                "SUMMARIES_ENABLED_BY_USER",
                "SUMMARIES_DISABLED_BY_USER",
                "ENABLED_MODERATION_EXPERIENCE_FOR_NON_COMMUNITY",
                "PRUNE_REQUIRES_ADMIN",
                "GUILD_TAGS_DISABLED",
            ];
            const requested = body.features;
            guild.features = [...guild.features.filter((x) => !MUTABLE_FEATURES.includes(x)), ...requested.filter((x) => MUTABLE_FEATURES.includes(x))];
            if (guild.features.includes("COMMUNITY") && !guild.features.includes("NEWS")) guild.features.push("NEWS");
            delete body.features;
        }

        for (const key of ["afk_channel_id", "system_channel_id", "rules_channel_id", "public_updates_channel_id", "safety_alerts_channel_id"] as const) {
            const value = body[key];
            if (value == null || value === "1") continue;
            if (!/^\d{1,20}$/.test(value))
                throw FieldErrors({
                    [key]: { code: "NUMBER_TYPE_COERCE", message: `Value "${value}" is not snowflake.` },
                });
        }
        const referencedChannels = [...new Set([body.afk_channel_id, body.system_channel_id, body.safety_alerts_channel_id].filter((id): id is string => !!id))];
        if (referencedChannels.length && (await Channel.count({ where: { guild_id, id: In(referencedChannels) } })) !== referencedChannels.length)
            throw DiscordApiErrors.UNKNOWN_CHANNEL;

        guild.assign(body);

        if (body.public_updates_channel_id == "1") {
            // create an updates channel for them
            const channel = await Channel.createChannel(
                {
                    name: "moderator-only",
                    guild_id: guild.id,
                    position: 0,
                    type: 0,
                    permission_overwrites: [
                        // remove SEND_MESSAGES from @everyone
                        {
                            id: guild.id,
                            allow: "0",
                            deny: Permissions.FLAGS.VIEW_CHANNEL.toString(),
                            type: 0,
                        },
                    ],
                },
                undefined,
                { skipPermissionCheck: true },
            );

            await Guild.insertChannelInOrder(guild.id, channel.id, 0, guild);

            guild.public_updates_channel_id = channel.id;
        } else if (body.public_updates_channel_id != undefined) {
            // ensure channel exists in this guild
            await Channel.findOneOrFail({
                where: { guild_id, id: body.public_updates_channel_id },
                select: { id: true },
            });
        }

        if (body.rules_channel_id == "1") {
            // create a rules for them
            const channel = await Channel.createChannel(
                {
                    name: "rules",
                    guild_id: guild.id,
                    position: 0,
                    type: 0,
                    permission_overwrites: [
                        // remove SEND_MESSAGES from @everyone
                        {
                            id: guild.id,
                            allow: "0",
                            deny: Permissions.FLAGS.SEND_MESSAGES.toString(),
                            type: 0,
                        },
                    ],
                },
                undefined,
                { skipPermissionCheck: true },
            );

            await Guild.insertChannelInOrder(guild.id, channel.id, 0, guild);

            guild.rules_channel_id = channel.id;
        } else if (body.rules_channel_id != undefined) {
            // ensure channel exists in this guild
            await Channel.findOneOrFail({
                where: { guild_id, id: body.rules_channel_id },
                select: { id: true },
            });
        }

        await Guild.getRepository().manager.transaction(async (manager) => {
            const current = await manager.findOneOrFail(Guild, {
                where: { id: guild_id },
                select: { id: true, owner_id: true },
                lock: { mode: "pessimistic_write" },
            });
            if (body.owner_id !== undefined && current.owner_id !== req.user_id) throw DiscordApiErrors.MISSING_PERMISSIONS;
            if (body.owner_id !== undefined) {
                const member = await manager.findOne(Member, {
                    where: { guild_id, id: body.owner_id },
                    select: { id: true },
                    lock: { mode: "pessimistic_read" },
                });
                if (!member) throw DiscordApiErrors.UNKNOWN_MEMBER;
            }
            // A concurrent settings edit must not restore the previous owner.
            guild.owner_id = body.owner_id ?? current.owner_id;
            auditBefore.owner_id = current.owner_id;
            await manager.save(guild);
        });

        reindexDiscoverySoon(guild_id);
        const changes = AuditLog.diff(auditBefore, guild, auditKeys);
        if (changes.length)
            await AuditLog.log({
                guild_id,
                user_id: req.user_id,
                action_type: AuditLogEvents.GUILD_UPDATE,
                target_id: guild_id,
                changes,
                reason: req.headers["x-audit-log-reason"],
            });

        const data = guild.toJSON();
        // TODO: guild hashes
        // TODO: fix vanity_url_code, template_id
        // delete data.vanity_url_code;
        delete data.template_id;

        await emitEvent({
            event: "GUILD_UPDATE",
            data: {
                ...data,
                afk_channel_id: data.afk_channel_id ?? undefined,
                public_updates_channel_id: data.public_updates_channel_id ?? undefined,
                rules_channel_id: data.rules_channel_id ?? undefined,
                system_channel_id: data.system_channel_id ?? undefined,
            } satisfies GuildCreateResponse,
            guild_id,
        } satisfies GuildUpdateEvent);
        if (wasApply && !isApplyGuild(guild.features)) await bulkActionJoinRequests(guild_id, req.user_id, "APPROVED");

        return res.json(data);
    },
);

export default router;
