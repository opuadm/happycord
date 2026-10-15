import crypto from "node:crypto";
import bcrypt from "bcrypt";
import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { MfaInvalidCode, MfaInvalidTicket, guardedMfaAttempt, isStaffDisabled, loginMfaResponse, readTicket, revokeSessions, verifyMfaMethod } from "@spacebar/api/util";
import { User } from "@spacebar/database";
import { Config, Email, FieldErrors, generateToken } from "@spacebar/util";

const router = Router({ mergeParams: true });

router.post(
    "/",
    route({
        responses: {
            200: {
                body: "TokenOnlyResponse",
            },
            400: {
                body: "APIErrorOrCaptchaResponse",
            },
        },
        authentication: "never",
    }),
    async (req: Request, res: Response) => {
        const { password, token, ticket, code, method } = req.body as {
            password?: string;
            token?: string;
            ticket?: string;
            code?: string;
            method?: string;
        };

        const invalid = () =>
            FieldErrors({
                password: {
                    message: req.t("auth:password_reset.INVALID_TOKEN"),
                    code: "INVALID_TOKEN",
                },
            });

        const decoded = readTicket<{ typ: string; uid?: string; ph?: string }>(token, "password_reset");
        if (!decoded?.uid) throw invalid();

        const user = await User.findOne({
            where: { id: decoded.uid },
            select: {
                id: true,
                username: true,
                discriminator: true,
                email: true,
                data: true,
                mfa_enabled: true,
                totp_secret: true,
                disabled: true,
                flags: true,
                deleted: true,
            },
        });
        const ph = crypto
            .createHash("sha256")
            .update(user?.data?.hash ?? "")
            .digest("base64url")
            .slice(0, 16);
        if (!user || user.deleted || ph !== decoded.ph) throw invalid();

        const min = Config.get().register.password.minLength ?? 8;
        if (typeof password !== "string" || password.length < min || password.length > 72)
            throw FieldErrors({
                password: {
                    code: "PASSWORD_REQUIREMENTS_MIN_LENGTH",
                    message: req.t("auth:register.PASSWORD_REQUIREMENTS_MIN_LENGTH", { min }),
                },
            });

        if (!ticket) {
            const mfa = await loginMfaResponse(req, user, { reset: decoded.uid });
            if (mfa) return res.json({ ...mfa, token: undefined, login_instance_id: undefined });
        } else {
            const mfaTicket = readTicket<{ typ: string; uid?: string; reset?: string }>(ticket, "login");
            if (!mfaTicket?.uid || mfaTicket.reset !== user.id) throw MfaInvalidTicket();
            if (!(await guardedMfaAttempt(ticket, () => verifyMfaMethod(user.id, method ?? "totp", code, mfaTicket)))) throw MfaInvalidCode();
        }

        await User.update(
            { id: user.id },
            {
                data: {
                    ...user.data,
                    hash: await bcrypt.hash(password, 12),
                    valid_tokens_since: new Date(),
                },
                disabled: !!user.disabled && isStaffDisabled(user.flags),
            },
        );
        await revokeSessions(user.id);

        if (user.email) await Email.sendPasswordChanged(user, user.email).catch(() => {});

        res.json({ token: await generateToken(user.id) });
    },
);

export default router;
