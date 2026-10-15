import { SelectProtocolSchema, validateSchema } from "@spacebar/schemas";
import { mediaServer, Send, VoiceOPCodes, VoicePayload, WebRtcWebSocket } from "@spacebar/webrtc";
import type { Codec } from "@spacebarchat/spacebar-webrtc-types";
import { DAVE_PROTOCOL_VERSION, DaveSession } from "../dave/DaveSession";
import { daveIds } from "../util/DaveIdentity";

export async function onSelectProtocol(this: WebRtcWebSocket, payload: VoicePayload) {
    if (!this.webRtcClient) return;

    const data = validateSchema("SelectProtocolSchema", payload.d) as SelectProtocolSchema;

    if (data.protocol !== "webrtc") return this.close(4000, "only webrtc protocol supported currently");

    const response = await mediaServer.onOffer(
        this.webRtcClient,
        data.sdp ?? (typeof data.data === "string" ? data.data : ""),
        (data.codecs ?? []).filter((codec): codec is Codec => ["opus", "VP8", "VP9", "H264"].includes(codec.name)),
    );
    this.daveVersion = Math.min(this.maxDaveVersion, DAVE_PROTOCOL_VERSION);

    await Send(this, {
        op: VoiceOPCodes.SESSION_DESCRIPTION,
        d: {
            video_codec: response.selectedVideoCodec,
            sdp: response.sdp,
            media_session_id: this.session_id,
            audio_codec: "opus",
            dave_protocol_version: this.daveVersion,
            ...(this.federation && this.channel_id && { meowcord_dave: { channel_id: this.channel_id, group: this.channel_id } }),
        },
    });

    const { voiceRoomId } = this.webRtcClient;
    const others = [...mediaServer.getClientsForRtcServer<WebRtcWebSocket>(voiceRoomId)].filter((client) => client.user_id !== this.user_id);

    if (others.length)
        await Send(this, {
            op: VoiceOPCodes.CLIENTS_CONNECT,
            d: {
                user_ids: others.map((client) => client.user_id),
                ...daveIds(
                    others.map((client) => client.websocket),
                    this,
                ),
            },
        });

    for (const client of others) {
        await Send(client.websocket, {
            op: VoiceOPCodes.CLIENTS_CONNECT,
            d: { user_ids: [this.user_id], ...daveIds([this], client.websocket) },
        });
        await Send(client.websocket, {
            op: VoiceOPCodes.CLIENT_FLAGS,
            d: { user_id: this.user_id, flags: 0 },
        });
        await Send(client.websocket, {
            op: VoiceOPCodes.CLIENT_PLATFORM,
            d: { user_id: this.user_id, platform: this.clientPlatform ?? 0 },
        });
        await Send(this, { op: VoiceOPCodes.CLIENT_FLAGS, d: { user_id: client.user_id, flags: 0 } });
        await Send(this, {
            op: VoiceOPCodes.CLIENT_PLATFORM,
            d: { user_id: client.user_id, platform: client.websocket.clientPlatform ?? 0 },
        });
    }

    if (this.daveVersion > 0) await DaveSession.get(voiceRoomId, this.channel_id ?? voiceRoomId).join(this);
}
