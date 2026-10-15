/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { Guild } from "@spacebar/database";
import { canonicalId, Config, isDocumentLive } from "@spacebar/util";
import { GuildGlobalDiscoverySchema } from "@spacebar/schemas";
import {
    announceSoon,
    currentDocument,
    ensurePermanentInvite,
    guildRegistryStatus,
    instanceId,
    instanceUrl,
    invalidateSignedDiscoveryList,
    localBlocks,
    permanentInvite,
} from "@spacebar/api/util/utility/federation";

const router = Router({ mergeParams: true });

const ownedGuild = async (req: Request) => {
    const guild = await Guild.findOne({
        where: { id: req.params.guild_id as string },
        select: { id: true, owner_id: true, system_channel_id: true, global_discovery: true, global_discovery_hidden: true, global_discovery_verified: true },
    });
    if (!guild) throw new HTTPError("Unknown Guild", 404);
    if (guild.owner_id !== req.user_id) throw new HTTPError("Only the server owner can change this", 403);
    return guild;
};

const describe = async (guild: Guild, invite: string | null) => {
    const id = instanceId();
    const document = await currentDocument();
    const canonical = id ? canonicalId(guild.id, id) : null;
    const url = instanceUrl();
    const status = !guild.global_discovery
        ? "off"
        : guild.global_discovery_hidden
          ? "hidden"
          : !invite
            ? "no_invite"
            : !guild.global_discovery_verified
              ? "unverified"
              : canonical && Config.get().federation.discovery.verification === "registry"
                ? guildRegistryStatus(document, canonical, await localBlocks())
                : "pending";
    return {
        enabled: guild.global_discovery,
        hidden: guild.global_discovery_hidden,
        verified: guild.global_discovery_verified,
        status,
        canonical_id: canonical,
        invite_url: invite && url ? `${url}/invite/${invite}` : null,
        federation_enabled: Config.get().federation.enabled,
        registry_live: isDocumentLive(document),
    };
};

router.get("/", route({ description: "Whether this server shows on other instances, for its owner" }), async (req: Request, res: Response) => {
    const guild = await ownedGuild(req);
    const invite = guild.global_discovery ? await permanentInvite(guild.id) : null;
    res.json(await describe(guild, invite));
});

router.patch(
    "/",
    route({ requestBody: "GuildGlobalDiscoverySchema", description: "Turn Show on other instances on or off. Turning it on creates a permanent invite when the server has none." }),
    async (req: Request, res: Response) => {
        const { enabled } = req.body as GuildGlobalDiscoverySchema;
        const guild = await ownedGuild(req);
        const invite = enabled ? await ensurePermanentInvite(guild) : null;
        if (enabled && !invite) throw new HTTPError("Add a text channel first, so people from other instances have somewhere to land", 400);
        guild.global_discovery = enabled;
        await Guild.update({ id: guild.id }, { global_discovery: enabled });
        invalidateSignedDiscoveryList();
        if (guild.global_discovery_verified && !guild.global_discovery_hidden) announceSoon();
        res.json(await describe(guild, invite));
    },
);

export default router;
