import { GoLiveStreams, Stream } from "@spacebar/database";
import { parseStreamKey, Payload, WebSocket } from "@spacebar/gateway";
import { FederatedVoice } from "@spacebar/util";

export async function onStreamSetPaused(this: WebSocket, { d }: Payload) {
    if (typeof d?.stream_key !== "string") return;
    if (await FederatedVoice.relayStream(this.user_id, this.session_id, "paused", { stream_key: d.stream_key, paused: !!d.paused })) return;
    const { channelId, userId } = parseStreamKey(d.stream_key);
    if (userId !== this.user_id) return;
    const stream = await Stream.findOne({ where: { channel_id: channelId, owner_id: userId } });
    if (stream) await GoLiveStreams.publishUpdate(stream.id, !!d.paused);
}
