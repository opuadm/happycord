import { Config } from "./Config";

export interface InstanceResourceLimits {
    user: { maxGuilds: number; maxUsername: number; maxFriends: number; maxBio: number; maxPronouns: number };
    guild: { maxRoles: number; maxEmojis: number; maxStickers: number; maxMembers: number; maxChannels: number; maxBulkBanUsers: number; maxChannelsInCategory: number };
    message: {
        maxCharacters: number;
        maxTTSCharacters: number;
        maxReactions: number;
        maxAttachments: number;
        maxAttachmentSize: number;
        maxBulkDelete: number;
        maxEmbedDownloadSize: number;
        maxPreloadCount: number;
        maxEmbeds: number;
        maxEmbedCharacters: number;
    };
    channel: { allowSlowmodeBypass: boolean; maxPins: number; maxTopic: number; maxWebhooks: number; maxName: number; maxGroupDmRecipients: number };
}

export function instanceLimits(): InstanceResourceLimits {
    const { user, guild, message, channel } = Config.get().limits;
    return {
        user: { ...user },
        guild: { ...guild },
        message: { ...message },
        channel: { ...channel },
    };
}
