import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { Guild } from "@spacebar/database";
import { GuildHomeSettings } from "@spacebar/schemas";
import { getPermission } from "@spacebar/util";

const router = Router({ mergeParams: true });

const toResponse = (guild_id: string, settings?: Partial<GuildHomeSettings> | null): GuildHomeSettings => ({
    guild_id,
    enabled: settings?.enabled ?? false,
    welcome_message: settings?.welcome_message ?? { author_ids: [], message: "" },
    new_member_actions: settings?.new_member_actions ?? [],
    resource_channels: settings?.resource_channels ?? [],
});

router.get("/", route({}), async (req: Request, res: Response) => {
    const { guild_id } = req.params as { [key: string]: string };
    await getPermission(req.user_id, guild_id);
    const guild = await Guild.findOneOrFail({
        where: { id: guild_id },
        select: { id: true, home_settings: true },
    });
    res.json(toResponse(guild_id, guild.home_settings));
});

router.put("/", route({ permission: "MANAGE_GUILD" }), async (req: Request, res: Response) => {
    const { guild_id } = req.params as { [key: string]: string };
    const guild = await Guild.findOneOrFail({
        where: { id: guild_id },
        select: { id: true, home_settings: true },
    });
    const settings = toResponse(guild_id, {
        ...toResponse(guild_id, guild.home_settings),
        ...(req.body as Partial<GuildHomeSettings>),
    });
    await Guild.update({ id: guild_id }, { home_settings: settings });
    res.json(settings);
});

export default router;
