import { Request, Response, Router } from "express";
import { captchaKeyFrom, checkCaptcha } from "@spacebar/api/util";
import { route } from "@spacebar/api/middlewares";
import { User } from "@spacebar/database";
import { Config, Email, FieldErrors } from "@spacebar/util";
import { ForgotPasswordSchema } from "@spacebar/schemas";

const router = Router({ mergeParams: true });

const minimumResponseMs = 400;

router.post(
    "/",
    route({
        requestBody: "ForgotPasswordSchema",
        responses: {
            200: {},
            400: {
                body: "APIErrorOrCaptchaResponse",
            },
        },
        authentication: "never",
    }),
    async (req: Request, res: Response) => {
        const { login } = req.body as ForgotPasswordSchema;

        if (!login?.trim())
            throw FieldErrors({
                login: { code: "BASE_TYPE_REQUIRED", message: req.t("common:field.BASE_TYPE_REQUIRED") },
            });

        const config = Config.get();

        const captcha = await checkCaptcha(config.passwordReset.requireCaptcha, captchaKeyFrom(req), "password_reset");
        if (captcha) return res.status(400).json(captcha);

        const started = Date.now();
        const user = await User.findOne({
            where: User.loginWhere(login),
            select: { username: true, discriminator: true, id: true, email: true, deleted: true },
        });

        const email = user?.deleted ? undefined : user?.email;
        if (user && email)
            Promise.resolve()
                .then(() => Email.sendResetPassword(user, email))
                .catch((e) => console.error(`Failed to send password reset email to ${user.tag} (${user.id}): ${e}`));

        await new Promise((resolve) => setTimeout(resolve, Math.max(0, started + minimumResponseMs - Date.now())));
        res.json({ method: "password_reset" });
    },
);

export default router;
