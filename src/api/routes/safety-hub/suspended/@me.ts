import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { User } from "@spacebar/database";
import { AccountStandingResponse, AppealEligibility } from "@spacebar/schemas";
import { accountStanding, getUserViolations, toClassification } from "@spacebar/api/util";

const router = Router({ mergeParams: true });

router.get(
    "/",
    route({
        responses: {
            200: {
                body: "AccountStandingResponse",
            },
            401: {
                body: "APIErrorResponse",
            },
        },
    }),
    async (req: Request, res: Response) => {
        const user = await User.findOneOrFail({
            where: { id: req.user_id },
            select: {
                id: true,
                username: true,
                discriminator: true,
                disabled: true,
                account_standing: true,
                suspended_until: true,
            },
        });
        const violations = await getUserViolations(user.id);

        res.send({
            classifications: violations.map(toClassification),
            guild_classifications: [],
            account_standing: {
                state: accountStanding(user, violations),
            },
            is_dsa_eligible: true,
            username: user.username,
            discriminator: user.discriminator,
            is_appeal_eligible: true,
            appeal_eligibility: [AppealEligibility.DSA_ELIGIBLE, AppealEligibility.IN_APP_ELIGIBLE, AppealEligibility.AGE_VERIFY_ELIGIBLE],
        } as AccountStandingResponse);
    },
);

export default router;
