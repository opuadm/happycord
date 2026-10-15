import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { Channel } from "@spacebar/database";
import { ChannelType } from "@spacebar/schemas";
import { Not, IsNull } from "typeorm";
import { getPermission } from "@spacebar/util";

const router = Router({ mergeParams: true });

router.get("/", route({}), async (req: Request, res: Response) => {
    const { guild_id } = req.params as { [key: string]: string };
    await getPermission(req.user_id, guild_id);
    const channels = await Channel.find({
        where: { guild_id, type: ChannelType.GUILD_TEXT, last_message_id: Not(IsNull()) },
        select: { id: true, last_message_id: true },
    });
    res.json(
        channels
            .sort((a, b) => (BigInt(b.last_message_id!) > BigInt(a.last_message_id!) ? 1 : -1))
            .slice(0, 10)
            .map((channel) => channel.id),
    );
});

export default router;
