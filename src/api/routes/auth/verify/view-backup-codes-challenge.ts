import crypto from "node:crypto";
import bcrypt from "bcrypt";
import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { signTicket } from "@spacebar/api/util";
import { User } from "@spacebar/database";
import { Config, Email, FieldErrors, JwtKeypairManager, escapeHtml } from "@spacebar/util";

const router = Router({ mergeParams: true });

export const hashKey = (key: string, user_id: string) => {
    const secret = crypto.hkdfSync("sha256", JwtKeypairManager.keypair.privateKey.export({ format: "der", type: "pkcs8" }), user_id, "backup-codes-challenge", 32);
    return crypto.createHmac("sha256", Buffer.from(secret)).update(key.trim().toLowerCase()).digest("base64url");
};

router.post(
    "/",
    route({
        responses: {
            200: { body: "BackupCodesChallengeResponse" },
            400: { body: "APIErrorResponse" },
        },
    }),
    async (req: Request, res: Response) => {
        const { password } = req.body as { password?: string };

        const user = await User.findOneOrFail({
            where: { id: req.user_id },
            select: { id: true, username: true, email: true, data: true },
        });

        if (!password || !(await bcrypt.compare(password, user.data.hash || "")))
            throw FieldErrors({
                password: {
                    message: req.t("auth:login.INVALID_PASSWORD"),
                    code: "INVALID_PASSWORD",
                },
            });

        const key = crypto.randomBytes(4).toString("hex");
        const kh = hashKey(key, user.id);
        if (!Email.transporter || !user.email) console.log(`[Email] Skipped backup codes verification delivery for user ${user.id}: email delivery is unavailable`);
        else {
            const { instanceName } = Config.get().general;
            await Email.transporter.sendMail({
                from: Config.get().email.senderAddress || Config.get().general.correspondenceEmail || "noreply@localhost",
                to: user.email,
                subject: `Your ${instanceName} backup codes verification key`,
                text: `Hey ${user.username},\n\nUse this key to view or regenerate your backup codes: ${key}\n\nThis key expires in 30 minutes.`,
                html: `<p>Hey ${escapeHtml(user.username)},</p><p>Use this key to view or regenerate your backup codes:</p><p style="font-size:24px;font-weight:bold;letter-spacing:2px">${key}</p><p>This key expires in 30 minutes.</p>`,
            });
        }

        res.json({
            nonce: signTicket({ typ: "backup_codes", uid: user.id, kh, regenerate: false, n: crypto.randomUUID() }, 1800),
            regenerate_nonce: signTicket({ typ: "backup_codes", uid: user.id, kh, regenerate: true, n: crypto.randomUUID() }, 1800),
        });
    },
);

export default router;
