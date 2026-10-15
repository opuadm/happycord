import { CLOSECODES } from "@spacebar/gateway";
import OPCodeHandlers from "../opcodes";
import { VoiceOPCodes, VoicePayload, WebRtcWebSocket } from "../util";

export async function onMessage(this: WebRtcWebSocket, buffer: Buffer, isBinary: boolean) {
    if (this.readyState !== 1) return;
    const now = Date.now();
    if (!this.commandWindow || now - this.commandWindow.start >= 10000) this.commandWindow = { start: now, count: 0 };
    if (++this.commandWindow.count > (this.user_id ? 200 : 10)) return this.close(4008, "Command rate exceeded");
    try {
        const data: VoicePayload = isBinary ? { op: buffer[0], d: buffer.subarray(1) } : JSON.parse(buffer.toString());
        if (!Number.isInteger(data?.op)) return this.close(CLOSECODES.Decode_error);
        if (this.federation && !isBinary && data.d !== undefined && ![VoiceOPCodes.HEARTBEAT, VoiceOPCodes.SELECT_PROTOCOL].includes(data.op))
            data.d = await this.federation.incoming(data.d);
        if (![VoiceOPCodes.IDENTIFY, VoiceOPCodes.RESUME, VoiceOPCodes.HEARTBEAT].includes(data.op) && !this.user_id) return this.close(CLOSECODES.Not_authenticated);

        if (this.user_id && [VoiceOPCodes.IDENTIFY, VoiceOPCodes.RESUME].includes(data.op)) return this.close(4005, "Already authenticated");
        const OPCodeHandler = OPCodeHandlers[data.op];
        if (!OPCodeHandler) {
            return this.close(CLOSECODES.Unknown_opcode);
        }

        if (![VoiceOPCodes.HEARTBEAT, VoiceOPCodes.SPEAKING].includes(data.op as VoiceOPCodes)) {
            console.log(`[WebRTC] Opcode ${VoiceOPCodes[data.op]}`);
        }

        await OPCodeHandler.call(this, data);
        if ([VoiceOPCodes.IDENTIFY, VoiceOPCodes.RESUME].includes(data.op) && this.user_id && this.readyState === 1) clearTimeout(this.authenticationTimeout);
    } catch (error) {
        console.error("[WebRTC] error", error);
        this.close(CLOSECODES.Decode_error);
    }
}
