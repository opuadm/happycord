import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { AuditLog, Guild, Role } from "@spacebar/database";
import { assertMirrorGuildEditable } from "@spacebar/api/util/utility/federatedAdmin";
import { AdminRoleUpdateSchema, AuditLogEvents } from "@spacebar/schemas";
import { emitEvent, GuildRoleUpdateEvent } from "@spacebar/util";
import { HTTPError } from "lambert-server/HTTPError";
const router = Router({ mergeParams: true });
router.patch(
    "/",
    route({
        right: "MANAGE_GUILDS",
        spacebarOnly: true,
        requestBody: "AdminRoleUpdateSchema",
        description: "Edit a role's appearance and permissions in any server",
    }),
    async (req: Request, res: Response) => {
        const guild_id = req.params.guild_id as string;
        assertMirrorGuildEditable(await Guild.findOne({ where: { id: guild_id }, select: { id: true, federated_instance: true } }));
        const role = await Role.findOneOrFail({
            where: { id: req.params.role_id as string, guild_id },
        });
        if (role.managed) throw new HTTPError("Integration-managed roles must be changed through their integration", 400);
        const body = req.body as AdminRoleUpdateSchema;
        if (body.name !== undefined && !body.name.trim()) throw new HTTPError("Enter a role name", 400);
        const before = { ...role };
        role.assign({
            ...body,
            ...(body.name !== undefined ? { name: body.name.trim() } : {}),
            ...(body.color !== undefined ? { colors: { ...role.colors, primary_color: body.color } } : {}),
        });
        await role.save();
        await AuditLog.log({
            guild_id,
            user_id: req.user_id,
            action_type: AuditLogEvents.ROLE_UPDATE,
            target_id: role.id,
            changes: AuditLog.diff(before, role, Object.keys(body)),
        });
        await emitEvent({
            event: "GUILD_ROLE_UPDATE",
            guild_id,
            data: { guild_id, role },
        } satisfies GuildRoleUpdateEvent);
        res.json(role);
    },
);
export default router;
