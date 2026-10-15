/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { Guild, Member } from "@spacebar/database";
import { DiscordApiErrors } from "@spacebar/util";
import { GuildTheme, GuildThemeModifySchema } from "@spacebar/schemas";

const router = Router({ mergeParams: true });

router.get("/", route({}), async (req: Request, res: Response) => {
    const { guild_id } = req.params as { [key: string]: string };
    const [guild, member] = await Promise.all([Guild.findOne({ where: { id: guild_id } }), Member.findOne({ where: { guild_id, id: req.user_id } })]);
    if (!guild) throw DiscordApiErrors.UNKNOWN_GUILD;
    if (!member) throw DiscordApiErrors.MISSING_ACCESS;

    const theme = guild.theme ?? null;
    return res.json({
        theme,
        preset_id: theme?.preset_id ?? null,
        custom_user_theme_settings: theme?.custom_user_theme_settings ?? null,
        enabled: theme?.enabled ?? false,
    });
});

router.patch(
    "/",
    route({
        requestBody: "GuildThemeModifySchema",
        permission: "MANAGE_GUILD",
    }),
    async (req: Request, res: Response) => {
        const { guild_id } = req.params as { [key: string]: string };
        const guild = await Guild.findOne({ where: { id: guild_id } });
        if (!guild) throw DiscordApiErrors.UNKNOWN_GUILD;

        const body = req.body as GuildThemeModifySchema;
        const current = guild.theme;
        const custom = body.custom_user_theme_settings;
        const theme: GuildTheme = {
            preset_id: body.preset_id === undefined ? (current?.preset_id ?? null) : body.preset_id,
            custom_user_theme_settings:
                custom === undefined
                    ? (current?.custom_user_theme_settings ?? null)
                    : custom && {
                          colors: custom.colors,
                          gradient_color_stops: custom.gradient_color_stops,
                          gradient_angle: custom.gradient_angle ?? 0,
                          base_mix: custom.base_mix ?? 0,
                      },
            enabled: body.enabled ?? current?.enabled ?? false,
        };

        guild.theme = theme;
        await guild.save();

        await Guild.emitUpdate(guild_id);

        return res.json({
            theme,
            preset_id: theme.preset_id,
            custom_user_theme_settings: theme.custom_user_theme_settings,
            enabled: theme.enabled,
        });
    },
);

export default router;
