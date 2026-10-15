import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { MfaInvalidTicket, ResponseError, findCredential, guardedMfaAttempt, readTicket, verifyAssertion } from "@spacebar/api/util";
import { User } from "@spacebar/database";
import { generateToken } from "@spacebar/util";

const router = Router({ mergeParams: true });

router.post("/", route({ authentication: "never", spacebarOnly: false }), async (req: Request, res: Response) => {
    const { ticket, credential } = req.body as { ticket?: string; credential?: string };
    const decoded = readTicket(ticket, "passwordless");
    if (!decoded?.ch || !decoded.origin) throw MfaInvalidTicket();

    const key = await findCredential(credential);
    if (!key || !(await guardedMfaAttempt(ticket!, () => verifyAssertion(credential, decoded.ch!, decoded.origin!, key, true))))
        throw new ResponseError(400, { message: "Invalid passkey", code: 60008 });

    const user = await User.findOneOrFail({
        where: { id: key.user_id },
        select: { id: true, disabled: true, deleted: true },
        relations: { settings: true },
    });
    if (user.deleted)
        throw new ResponseError(400, {
            message: "This account is scheduled for deletion.",
            code: 20011,
        });
    if (user.disabled) throw new ResponseError(400, { message: "This account is disabled.", code: 20013 });

    res.json({
        user_id: user.id,
        token: await generateToken(user.id),
        user_settings: { locale: user.settings?.locale, theme: user.settings?.theme },
    });
});

export default router;
