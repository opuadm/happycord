// TODO: dedicated schemas?
import { User_DisplayNameEffect, User_DisplayNameFont } from "discord-protos";

export interface UserModifySchema {
    /**
     * @minLength 2
     */
    username?: string;
    global_name?: string | null;
    avatar?: string | null;
    avatar_description?: string | null;
    bio?: string;
    accent_color?: number;
    banner?: string | null;
    /**
     * @minLength 1
     * @maxLength 72
     */
    password?: string;
    /**
     * @minLength 1
     * @maxLength 72
     */
    new_password?: string;
    /**
     * @minLength 6
     * @maxLength 6
     */
    code?: string;
    /**
     * @TJS-format email
     */
    email?: string;
    /**
     * @minLength 4
     * @maxLength 4
     */
    discriminator?: string;

    avatar_id?: string | null;
    email_token?: string;
    legacy_username?: string | null;
    date_of_birth?: string;
    flags?: number;

    display_name_colors?: number[] | null;
    display_name_effect_id?: User_DisplayNameEffect | null;
    display_name_font_id?: User_DisplayNameFont | null;

    avatar_decoration_id?: string | null;
    avatar_decoration_sku_id?: string | null;
    nameplate_sku_id?: string | null;
    primary_guild_id?: string | null;
    vad_colors?: number[] | null;
    typing_indicator_style?: number | null;

    push_provider?: string;
    push_token?: string;
    push_voip_provider?: string;
    push_voip_token?: string;
}
