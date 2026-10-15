import { WebSocket } from "@spacebar/gateway";
import type { WebRtcClient } from "@spacebarchat/spacebar-webrtc-types";

export interface WebRtcWebSocket extends WebSocket {
    remoteAddress?: string;
    authenticationTimeout?: NodeJS.Timeout;
    commandWindow?: { start: number; count: number };
    type: "guild-voice" | "dm-voice" | "stream";
    webRtcClient?: WebRtcClient<WebRtcWebSocket>;
    voiceRoomId?: string;
    channel_id?: string;
    server_id?: string;
    token?: string;
    voiceSequence: number;
    maxDaveVersion: number;
    daveId?: string;
    daveVersion: number;
    clientPlatform?: number;
    sentMessages?: { seq: number; data: string | Buffer }[];
    sessionCleanups?: (() => Promise<unknown>)[];
    resumedBy?: WebRtcWebSocket;
    sessionEnded?: boolean;
    resumeTimer?: NodeJS.Timeout;
    lastActivity?: number;
    speaking?: number;
    moderation?: VoiceModeration;
    federation?: FederatedVoiceSocket;
    inbox?: Promise<unknown>;
    queuedMessages?: number;
    federationOutbox?: Promise<unknown>;
}

export interface FederatedVoiceSocket {
    sender: string;
    incoming(data: unknown): Promise<unknown>;
    outgoing(data: unknown): Promise<unknown>;
}

export interface VoiceModeration {
    mute: boolean;
    deaf: boolean;
    video: boolean;
}
