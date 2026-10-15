import { ChannelPermissionOverwriteType, ChannelType, DefaultReaction, TagCreateSchema } from "@spacebar/schemas";

export interface ChannelModifySchema {
    name?: string;
    type?: ChannelType;
    topic?: string | null;
    icon?: string | null;
    owner?: string;
    bitrate?: number;
    user_limit?: number;
    rate_limit_per_user?: number;
    position?: number;
    invitable?: boolean;
    permission_overwrites?: {
        id: string;
        type: ChannelPermissionOverwriteType;
        allow: string;
        deny: string;
    }[];
    applied_tags?: string[];
    parent_id?: string | null;
    id?: string; // is not used (only for guild create)
    nsfw?: boolean;
    rtc_region?: string | null;
    default_auto_archive_duration?: number | null;
    default_reaction_emoji?: DefaultReaction | null;
    default_sort_order?: number | null;
    default_forum_layout?: number | null;
    default_tag_setting?: string | null;
    flags?: number;
    default_thread_rate_limit_per_user?: number;
    video_quality_mode?: number;
    auto_archive_duration?: number;
    archived?: boolean;
    locked?: boolean;
    available_tags?: (TagCreateSchema & { id?: string | null })[];
    template?: string | null;
    icon_emoji?: { id?: string | null; name?: string | null } | null;
    theme_color?: number | null;
    application_id?: string | null;
}
