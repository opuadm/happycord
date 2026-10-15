/* SPDX-License-Identifier: AGPL-3.0-only */
import { In, Raw } from "typeorm";
import { User } from "@spacebar/database";
import { emitEvent, UserUpdateEvent } from "@spacebar/util";
import { broadcastUserUpdate } from "./Presence";

export const NO_GUILD_TAG = { identity_guild_id: null, identity_enabled: false, tag: null, badge: null };

export async function dropGuildTags(guild_id: string, user_ids?: string[]) {
    if (user_ids && !user_ids.length) return 0;
    const wearers = await User.find({
        where: {
            primary_guild: Raw((alias) => `${alias} ->> 'identity_guild_id' = :guild_id`, { guild_id }),
            ...(user_ids ? { id: In(user_ids) } : {}),
        },
    });
    for (const user of wearers) {
        user.primary_guild = { ...NO_GUILD_TAG };
        await user.save();
        await emitEvent({ event: "USER_UPDATE", user_id: user.id, data: user.toPrivateUser() as unknown as UserUpdateEvent["data"] } satisfies UserUpdateEvent);
        void broadcastUserUpdate(user.id).catch(() => undefined);
    }
    return wearers.length;
}
