import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { purgeDeletedChannels } from "@spacebar/api/util";
import { Guild } from "@spacebar/database";
import { GuildDeleteEvent, dropGuildTags, emitEvent } from "@spacebar/util";

const router = Router({ mergeParams: true });

// discord prefixes this route with /delete instead of using the delete method
// docs are wrong https://discord.com/developers/docs/resources/guild#delete-guild
router.post(
    "/",
    route({
        responses: {
            204: {},
            401: {
                body: "APIErrorResponse",
            },
            404: {
                body: "APIErrorResponse",
            },
        },
    }),
    async (req: Request, res: Response) => {
        const { guild_id } = req.params as { [key: string]: string };

        const guild = await Guild.findOneOrFail({
            where: { id: guild_id },
            select: { owner_id: true },
        });
        if (guild.owner_id !== req.user_id) throw new HTTPError("You are not the owner of this guild", 401);

        await Promise.all([
            Guild.delete({ id: guild_id }), // this will also delete all guild related data
            dropGuildTags(guild_id),
            emitEvent({
                event: "GUILD_DELETE",
                data: {
                    id: guild_id,
                },
                guild_id: guild_id,
            } satisfies GuildDeleteEvent),
        ]);
        void purgeDeletedChannels();

        return res.sendStatus(204);
    },
);

export default router;
