import { PrivateCalls, Recipient } from "@spacebar/database";
import { OPCODES, Payload, Send, WebSocket } from "@spacebar/gateway";
import { FederatedVoice } from "@spacebar/util";

export async function onCallConnect(this: WebSocket, { d }: Payload) {
    const channelId = d?.channel_id;
    if (typeof channelId !== "string") return;
    if (!(await Recipient.exists({ where: { channel_id: channelId, user_id: this.user_id } }))) return;

    const call = FederatedVoice.remoteCall(channelId) ?? (await PrivateCalls.createPayload(channelId));
    if (call) await Send(this, { op: OPCODES.Dispatch, t: "CALL_CREATE", d: call });
}
