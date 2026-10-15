/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { Guild } from "@spacebar/database";
import { canonicalId, Config } from "@spacebar/util";
import { currentDocument, guildIconUrl, guildRegistryStatus, instanceId, instanceUrl, localBlocks, permanentInvite } from "@spacebar/api/util/utility/federation";

const router = Router({ mergeParams: true });

router.get(
    "/",
    route({
        right: "OPERATOR",
        spacebarOnly: true,
        description: "Local servers whose owners turned on Show on other instances, with whether this instance verified them and their registry status",
    }),
    async (req: Request, res: Response) => {
        const guilds = await Guild.find({
            where: { global_discovery: true },
            select: { id: true, name: true, icon: true, member_count: true, owner_id: true, global_discovery_hidden: true, global_discovery_verified: true },
            order: { member_count: "DESC" },
            take: 1000,
        });
        const id = instanceId();
        const url = instanceUrl();
        const [document, local] = await Promise.all([currentDocument(), localBlocks()]);
        const mode = Config.get().federation.discovery.verification;
        res.json(
            await Promise.all(
                guilds.map(async (guild) => {
                    const invite = await permanentInvite(guild.id);
                    const canonical = id ? canonicalId(guild.id, id) : null;
                    return {
                        id: guild.id,
                        canonical_id: canonical,
                        name: guild.name,
                        icon_url: guildIconUrl(guild),
                        member_count: guild.member_count ?? 0,
                        owner_id: guild.owner_id,
                        hidden: guild.global_discovery_hidden,
                        verified: guild.global_discovery_verified,
                        invite_url: invite && url ? `${url}/invite/${invite}` : null,
                        registry_status: !canonical ? "unknown" : guildRegistryStatus(document, canonical, local),
                        verification: mode,
                    };
                }),
            ),
        );
    },
);

export default router;
