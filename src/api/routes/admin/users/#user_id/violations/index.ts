import { Request, Response, Router } from "express";
import { In } from "typeorm";
import { route } from "@spacebar/api/middlewares";
import { User } from "@spacebar/database";
import { AdminViolationCreateSchema } from "@spacebar/schemas";
import { assertShadowUserEditable } from "@spacebar/api/util/utility/federatedAdmin";
import {
    accountStanding,
    assertCanActOnUser,
    automaticAccountStanding,
    getUserViolations,
    isActiveViolation,
    issueViolation,
    PERMANENT_VIOLATION_EXPIRY,
} from "@spacebar/api/util";

const router = Router({ mergeParams: true });

const PERMANENT = PERMANENT_VIOLATION_EXPIRY;

export async function describeStanding(user_id: string) {
    const user = await User.findOneOrFail({
        where: { id: user_id },
        select: { id: true, disabled: true, account_standing: true, suspended_until: true },
    });
    const violations = await getUserViolations(user_id);
    const issuers = await User.find({
        where: {
            id: In([...new Set(violations.map((v) => v.issued_by).filter((id): id is string => !!id))]),
        },
        select: { id: true, username: true, global_name: true },
    });
    return {
        standing: {
            state: accountStanding(user, violations),
            override: user.account_standing ?? null,
            automatic: automaticAccountStanding(user, violations),
        },
        violations: violations.map((v) => {
            const issuer = issuers.find((u) => u.id === v.issued_by);
            return {
                id: v.id,
                classification_type: v.classification_type,
                description: v.description,
                actions: v.actions,
                created_at: v.created_at,
                expires_at: v.expires_at,
                permanent: v.expires_at >= PERMANENT,
                active: isActiveViolation(v),
                appeal_status: v.appeal_status ?? null,
                appealed_at: v.appealed_at ?? null,
                appeal_signal: v.appeal_signal ?? null,
                appeal_user_input: v.appeal_user_input ?? null,
                appeal_resolved_by: v.appeal_resolved_by ?? null,
                issued_by: issuer ? { id: issuer.id, username: issuer.username, global_name: issuer.global_name ?? null } : v.issued_by ? { id: v.issued_by } : null,
            };
        }),
    };
}

router.get(
    "/",
    route({
        right: "VIEW_MODERATION",
        spacebarOnly: true,
        description: "A user's account standing and violations",
    }),
    async (req: Request, res: Response) => {
        res.json(await describeStanding(req.params.user_id as string));
    },
);

router.post(
    "/",
    route({
        right: "MODERATE_USERS",
        spacebarOnly: true,
        requestBody: "AdminViolationCreateSchema",
        description: "Add a violation to a user's account standing",
    }),
    async (req: Request, res: Response) => {
        const body = req.body as AdminViolationCreateSchema;
        const user_id = req.params.user_id as string;
        assertShadowUserEditable(await User.findOneOrFail({ where: { id: user_id }, select: { id: true, federated_instance: true } }), ["account standing"]);
        await assertCanActOnUser(req, user_id);
        await issueViolation(user_id, body, req.user_id);

        res.status(201).json(await describeStanding(user_id));
    },
);

export default router;
