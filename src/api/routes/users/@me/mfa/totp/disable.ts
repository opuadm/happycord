import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { MfaInvalidCode, ResponseError, currentToken, emitUserUpdate, hasRecentMfa, requireMfa, setSmsFlag, throttledCodeAttempt, verifyMfaMethod } from "@spacebar/api/util";
import { BackupCode, SecurityKey, User } from "@spacebar/database";

const router = Router({ mergeParams: true });

router.post(
    "/",
    route({
        responses: {
            200: {
                body: "TokenOnlyResponse",
            },
            400: {
                body: "APIErrorResponse",
            },
        },
    }),
    async (req: Request, res: Response) => {
        const user = await User.findOneOrFail({
            where: { id: req.user_id },
            select: { id: true, mfa_enabled: true, totp_secret: true },
        });
        if (!user.mfa_enabled || !user.totp_secret) throw new ResponseError(400, { message: "Two factor is not enabled.", code: 60002 });

        const { code } = req.body as { code?: string };
        if (code && !hasRecentMfa(req)) {
            if (!(await throttledCodeAttempt(req.user_id, () => verifyMfaMethod(req.user_id, "totp", code, { typ: "mfa", uid: req.user_id })))) throw MfaInvalidCode();
        } else await requireMfa(req);

        const keys = await SecurityKey.count({ where: { user_id: req.user_id } });
        await User.update({ id: req.user_id }, { mfa_enabled: keys > 0, totp_secret: "" });
        await setSmsFlag(req.user_id, false);
        if (!keys) await BackupCode.update({ user: { id: req.user_id } }, { expired: true });
        await emitUserUpdate(req.user_id);

        res.json({ token: currentToken(req) });
    },
);

export default router;
