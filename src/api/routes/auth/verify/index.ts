import { Request, Response, Router } from "express";
import { emitUserUpdate, readTicket, captchaKeyFrom, checkCaptcha } from "@spacebar/api/util";
import { route } from "@spacebar/api/middlewares";
import { User } from "@spacebar/database";
import { Config, emitRequiredAction, FieldErrors, generateToken } from "@spacebar/util";

const router = Router({ mergeParams: true });

router.post(
    "/",
    route({
        responses: {
            200: {
                body: "TokenResponse",
            },
            400: {
                body: "APIErrorOrCaptchaResponse",
            },
        },
        authentication: "optional",
    }),
    async (req: Request, res: Response) => {
        const { token } = req.body as { token?: string };

        const config = Config.get();

        const captcha = await checkCaptcha(config.register.requireCaptcha, captchaKeyFrom(req));
        if (captcha) return res.status(400).json(captcha);

        const invalid = () =>
            FieldErrors({
                token: {
                    message: req.t("auth:password_reset.INVALID_TOKEN"),
                    code: "INVALID_TOKEN",
                },
            });

        const decoded = readTicket<{ typ: string; uid?: string; email?: string }>(token, "email_verify");
        if (!decoded?.uid) throw invalid();

        const user = await User.findOne({
            where: { id: decoded.uid },
            select: { id: true, email: true, verified: true, disabled: true, deleted: true, mfa_enabled: true },
        });
        if (!user || user.disabled || user.deleted || !user.email || user.email !== decoded.email) throw invalid();

        const firstUse = !user.verified && ((await User.update({ id: user.id, verified: false }, { verified: true })).affected ?? 0) > 0;
        if (firstUse) {
            await emitUserUpdate(user.id);
            await emitRequiredAction(user.id);
        }

        if (req.user_id === user.id && req.headers.authorization) return res.json({ user_id: user.id, token: req.headers.authorization });
        if (!firstUse || user.mfa_enabled) return res.json({ user_id: user.id });
        res.json({ user_id: user.id, token: await generateToken(user.id) });
    },
);

export default router;
