import { route } from "@spacebar/api/middlewares";
import { User } from "@spacebar/database";
import { mutualFriendIds, remoteMutualFriends } from "@spacebar/api/util/utility/federationRelay";
import { Request, Response, Router } from "express";
import { UserMutualRelationsResponse } from "@spacebar/schemas";

const router: Router = Router({ mergeParams: true });

router.get(
    "/",
    route({
        description: "Get mutual relationships",
        responses: {
            200: { body: "UserRelationsResponse" },
            404: {
                body: "APIErrorResponse",
            },
        },
    }),
    async (req: Request, res: Response) => {
        const target = await User.findOneOrFail({ where: { id: req.params.user_id as string }, select: { id: true, federated_instance: true } });
        const relayed = target.federated_instance ? await remoteMutualFriends(req.user_id, target.id) : [];
        const ids = await mutualFriendIds(req.user_id, target.id, relayed);
        const mutual_relations: UserMutualRelationsResponse = [];
        for (const id of ids) {
            const user = await User.getPublicUser(id);
            mutual_relations.push({ id: user.id, username: user.username, avatar: user.avatar, discriminator: user.discriminator, public_flags: user.public_flags });
        }
        res.json(mutual_relations);
    },
);

export default router;
