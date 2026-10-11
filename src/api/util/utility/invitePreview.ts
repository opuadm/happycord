/* SPDX-License-Identifier: AGPL-3.0-only */
import { Invite } from "@spacebar/database";
import { Config, instanceName, OpenGraphPage } from "@spacebar/util";

const INVITE_PATH = /^\/invite\/([\w-]{1,64})\/?$/;

export const inviteCodeFromPath = (path: string) => INVITE_PATH.exec(path)?.[1] ?? null;

export const invitePage = async (code: string): Promise<OpenGraphPage | null> => {
    const invite = await Invite.findOne({
        where: { code },
        relations: { guild: true, channel: true },
        select: {
            code: true,
            uses: true,
            max_uses: true,
            max_age: true,
            expires_at: true,
            guild: { id: true, name: true, description: true, icon: true, member_count: true },
            channel: { id: true, name: true, type: true },
        },
    }).catch(() => null);
    if (!invite || invite.isExpired()) return null;
    const instance = instanceName();
    const url = `/invite/${invite.code}`;
    const { guild } = invite;
    if (!guild) return { title: `Join a group DM on ${instance}`, description: `You've been invited to a group DM on ${instance}.`, url };
    const others = Math.max(0, (guild.member_count ?? 1) - 1);
    const cdn = Config.get().cdn.endpointPublic?.replace(/\/+$/, "");
    return {
        title: `Join the ${guild.name} server on ${instance}`,
        description:
            guild.description?.trim() ||
            `Check out the ${guild.name} community on ${instance}, hang out with ${others.toLocaleString("en-US")} other ${others === 1 ? "member" : "members"} and enjoy free voice and text chat.`,
        url,
        ...(guild.icon ? { image: `${cdn ?? ""}/icons/${guild.id}/${guild.icon}.png?size=256`, imageSize: 256 } : {}),
    };
};
