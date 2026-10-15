import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { revokeSessions } from "@spacebar/api/util";
import { User } from "@spacebar/database";
import { Email, MailTypes } from "@spacebar/util";
import { AdminPasswordResetSchema } from "@spacebar/schemas";
import { assertShadowUserEditable } from "@spacebar/api/util/utility/federatedAdmin";
import { assertCanManage } from "../index";

const router = Router({ mergeParams: true });

router.post(
    "/",
    route({
        right: "SUPPORT_USERS",
        spacebarOnly: true,
        requestBody: "AdminPasswordResetSchema",
        description: "Make a one hour password reset link for a user, optionally emailing it and signing them out everywhere",
    }),
    async (req: Request, res: Response) => {
        const body = (req.body ?? {}) as AdminPasswordResetSchema;
        const user = await User.findOneOrFail({
            where: { id: req.params.user_id as string },
            select: {
                id: true,
                username: true,
                discriminator: true,
                email: true,
                rights: true,
                bot: true,
                data: true,
                federated_instance: true,
            },
        });
        assertCanManage(req, user);
        assertShadowUserEditable(user, ["the password"]);

        const link = await Email.generateLink(MailTypes.resetPassword, user.id);
        const emailed = !!(body.send_email && user.email && Email.transporter);
        if (emailed) await Email.sendResetPassword(user, user.email!);
        if (body.revoke_sessions) {
            await User.update({ id: user.id }, { data: { ...user.data, valid_tokens_since: new Date() } });
            await revokeSessions(user.id);
        }

        console.log(`[Admin] User ${req.user_id} made a password reset link for ${user.id}`);
        res.json({
            link,
            expires_in: 3600,
            emailed,
            email_available: !!(user.email && Email.transporter),
        });
    },
);

export default router;
