/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { FriendInvite } from "@spacebar/database";
import { InviteType } from "@spacebar/schemas/api/guilds/Invite";
import { Random } from "@spacebar/extensions";

const router = Router({ mergeParams: true });

export const serializeFriendInvite = (invite: FriendInvite) => ({
    code: invite.code,
    type: InviteType.FRIEND,
    inviter_id: invite.inviter_id,
    ...(invite.inviter ? { inviter: invite.inviter.toPublicUser() } : {}),
    uses: invite.uses,
    max_uses: invite.max_uses,
    max_age: invite.max_age,
    expires_at: invite.expires_at?.toISOString() ?? null,
    created_at: invite.created_at.toISOString(),
});

const generateCode = async (): Promise<string> => {
    for (let attempt = 0; attempt < 10; attempt++) {
        const code = Random.getString("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", 8);
        if (!(await FriendInvite.exists({ where: { code } }))) return code;
    }
    throw new Error("Could not generate a friend invite code");
};

router.get(
    "/",
    route({
        responses: { 200: {} },
    }),
    async (req: Request, res: Response) => {
        const invites = await FriendInvite.find({ where: { inviter_id: req.user_id }, relations: { inviter: true }, order: { created_at: "DESC" } });
        res.json(invites.filter((invite) => !invite.isExpired()).map(serializeFriendInvite));
    },
);

router.post(
    "/",
    route({
        responses: { 200: {}, 201: {} },
    }),
    async (req: Request, res: Response) => {
        const existing = await FriendInvite.findOne({ where: { inviter_id: req.user_id }, relations: { inviter: true }, order: { created_at: "DESC" } });
        if (existing && !existing.isExpired()) return res.json(serializeFriendInvite(existing));
        const max_age = Math.min(604800, Math.max(0, Number(req.body?.max_age) || 0));
        const invite = await FriendInvite.create({
            code: await generateCode(),
            inviter_id: req.user_id,
            uses: 0,
            max_uses: Math.max(0, Number(req.body?.max_uses) || 0),
            max_age,
            expires_at: max_age === 0 ? null : new Date(max_age * 1000 + Date.now()),
            created_at: new Date(),
        }).save();
        const created = await FriendInvite.findOneOrFail({ where: { code: invite.code }, relations: { inviter: true } });
        res.status(201).json(serializeFriendInvite(created));
    },
);

router.delete(
    "/",
    route({
        responses: { 200: {} },
    }),
    async (req: Request, res: Response) => {
        await FriendInvite.delete({ inviter_id: req.user_id });
        res.json([]);
    },
);

export default router;
