import { Channel, Member, VoiceChannels } from "@spacebar/database";
import { In } from "typeorm";
import { WebSocket, Payload, OPCODES, Send, handleOffloadedGatewayRequest } from "@spacebar/gateway";
import { ChannelType } from "@spacebar/schemas";
import { Config, getPermission } from "@spacebar/util";

export async function onRequestChannelInfo(this: WebSocket, { d }: Payload) {
    // Schema validation can only accept either string or array, so transforming it here to support both
    if (!d.guild_id) throw new Error('"guild_id" is required');
    if (!d.fields) throw new Error('"fields" is required');
    if (typeof d.guild_id !== "string" || !(await Member.exists({ where: { id: this.user_id, guild_id: d.guild_id } }))) return;

    if (Config.get().offload.gateway.channelInfoUrl !== null) {
        if (await handleOffloadedGatewayRequest(this, Config.get().offload.gateway.channelInfoUrl!, d)) return;
    }

    const occupied = (
        await Channel.find({
            where: {
                guild_id: d.guild_id,
                type: In([ChannelType.GUILD_VOICE, ChannelType.GUILD_STAGE_VOICE]),
            },
            relations: {
                voice_states: true,
            },
        })
    ).filter((c) => c.voice_states && c.voice_states.length > 0);
    const channels = [];
    for (const channel of occupied) if ((await getPermission(this.user_id, d.guild_id, channel.id).catch(() => null))?.has("VIEW_CHANNEL")) channels.push(channel);

    await Send(this, {
        op: OPCODES.Dispatch,
        t: "CHANNEL_INFO",
        d: {
            guild_id: d.guild_id,
            channels: await Promise.all(
                channels.map(async (c) => ({
                    id: c.id,
                    status: d.fields.includes("status") ? (c.status ?? null) : undefined,
                    voice_start_time: d.fields.includes("voice_start_time") ? await VoiceChannels.startTime(c.id) : undefined,
                })),
            ),
        },
    });
}
