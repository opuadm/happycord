import { Channel, Member } from "@spacebar/database";
import { WebSocket, Payload, OPCODES, Send, handleOffloadedGatewayRequest } from "@spacebar/gateway";
import { Not, IsNull } from "typeorm";
import { Config, getPermission } from "@spacebar/util";

export async function onRequestChannelStatuses(this: WebSocket, { d }: Payload) {
    // Schema validation can only accept either string or array, so transforming it here to support both
    if (!d.guild_id) throw new Error('"guild_id" is required');
    if (typeof d.guild_id !== "string" || !(await Member.exists({ where: { id: this.user_id, guild_id: d.guild_id } }))) return;

    if (Config.get().offload.gateway.channelStatusesUrl !== null) {
        if (await handleOffloadedGatewayRequest(this, Config.get().offload.gateway.channelStatusesUrl!, d)) return;
    }

    const channels = [];
    for (const channel of await Channel.find({
        where: { guild_id: d.guild_id, status: Not(IsNull()) },
        select: { id: true, status: true },
    }))
        if ((await getPermission(this.user_id, d.guild_id, channel.id).catch(() => null))?.has("VIEW_CHANNEL")) channels.push(channel);
    await Send(this, {
        op: OPCODES.Dispatch,
        t: "CHANNEL_STATUSES",
        d: {
            guild_id: d.guild_id,
            channels: channels.map((channel) => ({ id: channel.id, status: channel.status })),
        },
    });
}
