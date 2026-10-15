import { Request, Response, Router } from "express";
import { In } from "typeorm";
import { route } from "@spacebar/api/middlewares";
import { revokeStaleE2eeDevices } from "@spacebar/api/util";
import { Session, User } from "@spacebar/database";
import { emitEvent, Event } from "@spacebar/util";
import { AdminSessionsRevokeSchema } from "@spacebar/schemas";
import { assertCanManage } from "../../index";

const router = Router({ mergeParams: true });

const loadTarget = (req: Request) =>
    User.findOneOrFail({
        where: { id: req.params.user_id as string },
        select: { id: true, rights: true },
    });

router.get(
    "/",
    route({
        right: "VIEW_USERS",
        spacebarOnly: true,
        description: "A user's signed-in sessions, most recently used first",
    }),
    async (req: Request, res: Response) => {
        const user = await loadTarget(req);
        const sessions = await Session.find({ where: { user_id: user.id } });
        res.json(
            sessions
                .map((s) => ({
                    id: s.session_id,
                    status: s.status,
                    client_info: s.client_info ?? {},
                    client_status: s.client_status ?? {},
                    is_admin_session: s.is_admin_session,
                    created_at: s.created_at ?? null,
                    last_seen: s.last_seen ?? null,
                    last_seen_ip: s.last_seen_ip ?? null,
                    last_seen_location: s.last_seen_location ?? null,
                    nickname: s.session_nickname ?? null,
                }))
                .sort((a, b) => new Date(b.last_seen ?? b.created_at ?? 0).getTime() - new Date(a.last_seen ?? a.created_at ?? 0).getTime()),
        );
    },
);

router.post(
    "/logout",
    route({
        right: "SUPPORT_USERS",
        spacebarOnly: true,
        requestBody: "AdminSessionsRevokeSchema",
        description: "End some or all of a user's sessions",
        responses: { 204: {} },
    }),
    async (req: Request, res: Response) => {
        const body = (req.body ?? {}) as AdminSessionsRevokeSchema;
        const user = await loadTarget(req);
        assertCanManage(req, user);
        const sessions = await Session.find({
            where: {
                user_id: user.id,
                ...(body.session_ids ? { session_id: In(body.session_ids) } : {}),
            },
            select: { session_id: true },
        });
        for (const session of sessions) {
            await emitEvent({
                session_id: session.session_id,
                event: "SB_SESSION_REMOVE",
                origin: "Admin dashboard",
            } as Event);
            await Session.delete({ session_id: session.session_id });
        }
        if (!body.session_ids) {
            const { data } = await User.findOneOrFail({
                where: { id: user.id },
                select: { id: true, data: true },
            });
            await User.update({ id: user.id }, { data: { ...data, valid_tokens_since: new Date() } });
        }
        if (sessions.length) await revokeStaleE2eeDevices(user.id);
        console.log(`[Admin] User ${req.user_id} ended ${sessions.length} session(s) of ${user.id}`);
        res.sendStatus(204);
    },
);

export default router;
