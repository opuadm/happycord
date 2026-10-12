import { route } from "@spacebar/api/middlewares";
import { capContextEndpoint, capEndpoint, capSitekey, captchaEnabled, registrationCapEndpoint } from "@spacebar/api/util";
import { Config } from "@spacebar/util";
import { Request, Response, Router } from "express";
const router = Router({ mergeParams: true });

router.get(
    "/",
    route({
        responses: {
            200: {
                body: "CaptchaConfigResponse",
            },
        },
        spacebarOnly: true,
        authentication: "never",
    }),
    (req: Request, res: Response) => {
        const { register, login, passwordReset } = Config.get();
        const optional = captchaEnabled();
        if (!register.requireCaptcha && !optional) return res.json({ service: null, sitekey: null, endpoint: null, register: false, login: false, password_reset: false });
        res.json({
            service: "cap",
            sitekey: capSitekey(),
            endpoint: register.requireCaptcha ? registrationCapEndpoint() : capEndpoint(),
            register: register.requireCaptcha,
            login: login.requireCaptcha && optional,
            password_reset: passwordReset.requireCaptcha && optional,
            endpoints: {
                register: register.requireCaptcha ? registrationCapEndpoint() : capEndpoint(),
                login: capContextEndpoint("login"),
                password_reset: capContextEndpoint("password_reset"),
            },
        });
    },
);

export default router;
