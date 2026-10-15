import { ChannelModifySchema } from "./ChannelModifySchema";
import { TagCreateSchema } from "./TagCreateSchema";

export type ChannelCreateSchema = Omit<ChannelModifySchema, "available_tags" | "owner">;

export type GuildChannelCreateSchema = ChannelCreateSchema & { available_tags?: TagCreateSchema[] };
