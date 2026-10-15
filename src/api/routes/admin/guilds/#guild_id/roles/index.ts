import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { AuditLog, Guild, Role } from "@spacebar/database";
import { Config, DiscordApiErrors, emitEvent, GuildRoleCreateEvent, Permissions, Snowflake } from "@spacebar/util";
import { AdminRoleCreateSchema, AuditLogEvents } from "@spacebar/schemas";
import { HTTPError } from "lambert-server/HTTPError";
import { assertMirrorGuildEditable } from "@spacebar/api/util/utility/federatedAdmin";
const router = Router({ mergeParams: true });
router.get(
    "/",
    route({
        right: "MANAGE_GUILDS",
        spacebarOnly: true,
        description: "List server roles and available permission flags",
    }),
    async (req: Request, res: Response) => {
        const guild_id = req.params.guild_id as string;
        await Guild.findOneOrFail({ where: { id: guild_id }, select: { id: true } });
        res.json({
            roles: await Role.find({ where: { guild_id }, order: { position: "DESC" }, take: 1000 }),
            permissions: Object.entries(Permissions.FLAGS).map(([name, value]) => ({
                name,
                value: value.toString(),
            })),
        });
    },
);
router.post(
    "/",
    route({
        right: "MANAGE_GUILDS",
        spacebarOnly: true,
        requestBody: "AdminRoleCreateSchema",
        description: "Create a role in any server",
        responses: { 201: { body: "Role" } },
    }),
    async (req: Request, res: Response) => {
        const guild_id = req.params.guild_id as string;
        assertMirrorGuildEditable(await Guild.findOne({ where: { id: guild_id }, select: { id: true, federated_instance: true } }));
        const body = req.body as AdminRoleCreateSchema;
        const name = body.name.trim();
        if (!name) throw new HTTPError("Enter a role name", 400);
        const permissions = BigInt(body.permissions ?? "0");
        const allowedPermissions = Object.values(Permissions.FLAGS).reduce((bits, flag) => bits | flag, 0n);
        if (permissions < 0n || (permissions & ~allowedPermissions) !== 0n) throw new HTTPError("Permissions contain unsupported flags", 400);
        const role = await Guild.getRepository().manager.transaction(async (manager) => {
            await manager.findOneOrFail(Guild, {
                where: { id: guild_id },
                lock: { mode: "pessimistic_write" },
            });
            const { maxRoles } = Config.get().limits.guild;
            if ((await manager.count(Role, { where: { guild_id } })) >= maxRoles) throw DiscordApiErrors.MAXIMUM_ROLES.withParams(maxRoles);
            const created = Role.create({
                id: Snowflake.generate(),
                guild_id,
                name,
                permissions: permissions.toString(),
                position: 1,
                color: body.color ?? 0,
                colors: { primary_color: body.color ?? 0 },
                hoist: body.hoist ?? false,
                mentionable: body.mentionable ?? false,
                managed: false,
            });
            await manager
                .createQueryBuilder()
                .update(Role)
                .set({ position: () => "position + 1" })
                .where("guild_id = :guild_id AND id != :guild_id", { guild_id })
                .execute();
            return manager.save(created);
        });
        await AuditLog.log({
            guild_id,
            user_id: req.user_id,
            action_type: AuditLogEvents.ROLE_CREATE,
            target_id: role.id,
            changes: AuditLog.diff({}, role, ["name", "permissions", "color", "colors", "hoist", "mentionable"]),
            reason: req.headers["x-audit-log-reason"],
        });
        await emitEvent({
            event: "GUILD_ROLE_CREATE",
            guild_id,
            data: { guild_id, role },
        } satisfies GuildRoleCreateEvent);
        res.status(201).json(role);
    },
);
export default router;
