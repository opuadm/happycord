import { route } from "@spacebar/api/middlewares";
import { Config, getRights, instanceLimits } from "@spacebar/util";
import { Request, Response, Router } from "express";

const router = Router({ mergeParams: true });

router.get(
    "/",
    route({
        responses: {
            200: {
                body: "Object",
            },
        },
        spacebarOnly: true,
        authentication: "optional",
    }),
    async (req: Request, res: Response) => {
        const general = Config.get();
        let outputtedConfig;
        // TODO: clean up
        if (req.user_id) {
            const rights = await getRights(req.user_id);
            if (rights.has("OPERATOR")) outputtedConfig = general;
        }
        outputtedConfig ??= {
            limits: instanceLimits(),
            limits_user_maxGuilds: general.limits.user.maxGuilds,
            limits_user_maxBio: general.limits.user.maxBio,
            limits_guild_maxEmojis: general.limits.guild.maxEmojis,
            limits_guild_maxRoles: general.limits.guild.maxRoles,
            limits_message_maxCharacters: general.limits.message.maxCharacters,
            limits_message_maxAttachmentSize: general.limits.message.maxAttachmentSize,
            limits_message_maxEmbedDownloadSize: general.limits.message.maxEmbedDownloadSize,
            limits_channel_maxWebhooks: general.limits.channel.maxWebhooks,
            register_dateOfBirth_required: false,
            register_password_required: general.register.password.required,
            register_disabled: general.register.disabled,
            register_requireInvite: general.register.requireInvite,
            register_allowNewRegistration: general.register.allowNewRegistration,
            register_allowMultipleAccounts: general.register.allowMultipleAccounts,
            guild_autoJoin_canLeave: general.guild.autoJoin.canLeave,
            guild_autoJoin_guilds_x: general.guild.autoJoin.guilds,
            register_email_required: general.register.email.required,
            can_recover_account: general.email.provider != null && general.general.frontPage != null,
        };
        res.send(outputtedConfig);
    },
);

export default router;
