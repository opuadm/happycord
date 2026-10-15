import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { MfaInvalidCode, MfaInvalidTicket, guardedMfaAttempt, isStaffDisabled, readTicket, verifyMfaMethod } from "@spacebar/api/util";
import { User } from "@spacebar/database";
import { generateToken } from "@spacebar/util";

const router = Router({ mergeParams: true });

router.post("/", route({ authentication: "never", spacebarOnly: false }), async (req: Request, res: Response) => {
    const { authenticator_type } = req.params as { authenticator_type: string };
    const { code, ticket } = req.body as { code?: string; ticket?: string };
    const decoded = readTicket<{ typ: string; uid?: string; undelete?: boolean }>(ticket, "login");
    if (!decoded?.uid) throw MfaInvalidTicket();
    if (authenticator_type === "password") throw MfaInvalidCode();
    if (!(await guardedMfaAttempt(ticket!, () => verifyMfaMethod(decoded.uid!, authenticator_type, code, decoded)))) throw MfaInvalidCode();

    const user = await User.findOneOrFail({
        where: { id: decoded.uid },
        select: { id: true, disabled: true, deleted: true, flags: true },
        relations: { settings: true },
    });
    if (user.disabled && isStaffDisabled(user.flags)) throw MfaInvalidTicket();
    if (decoded.undelete && (user.disabled || user.deleted)) await User.update({ id: user.id }, { disabled: false, deleted: false });

    res.json({
        user_id: user.id,
        token: await generateToken(user.id),
        user_settings: { locale: user.settings?.locale, theme: user.settings?.theme },
    });
});

export default router;
