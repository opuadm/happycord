import { PrivateCalls, Session, StageInstances, Stream, VoiceState } from "@spacebar/database";
import { broadcastPresence, emitSessionsReplace, Event, PRESENCE_STALE_AFTER_MS, RabbitMQ } from "@spacebar/util";
import { WebSocket } from "./WebSocket";
import { OPCODES } from "./Constants";
import { Send } from "./Send";
import { ProcessLifecycle } from "../../util/util/ProcessLifecycle";

export function parseStreamKey(streamKey: string): {
    type: "guild" | "call";
    channelId: string;
    guildId?: string;
    userId: string;
} {
    const streamKeyArray = streamKey.split(":");

    const type = streamKeyArray.shift();

    if (type !== "guild" && type !== "call") {
        throw new Error(`Invalid stream key type: ${type}`);
    }

    if ((type === "guild" && streamKeyArray.length < 3) || (type === "call" && streamKeyArray.length < 2)) throw new Error(`Invalid stream key: ${streamKey}`); // invalid stream key

    let guildId: string | undefined;
    if (type === "guild") {
        guildId = streamKeyArray.shift();
    }
    const channelId = streamKeyArray.shift();
    const userId = streamKeyArray.shift();

    if (!channelId || !userId) {
        throw new Error(`Invalid stream key: ${streamKey}`);
    }
    return { type, channelId, guildId, userId };
}

export function generateStreamKey(type: "guild" | "call", guildId: string | undefined, channelId: string, userId: string): string {
    const streamKey = `${type}${type === "guild" ? `:${guildId}` : ""}:${channelId}:${userId}`;

    return streamKey;
}

let callStateCleanup: Promise<void> | undefined;

const HOSTED_HERE = `NOT (COALESCE("guild_id" IN (SELECT "id" FROM "guilds" WHERE "federated_instance" IS NOT NULL), false) OR COALESCE("guild_id" IS NULL AND "channel_id" IN (SELECT "id" FROM "channels" WHERE "federated_instance" IS NOT NULL), false))`;

export function clearCallStateOnStartup() {
    callStateCleanup ??= (async () => {
        console.log("[Gateway] Clearing voice states, streams and calls left from the last run...");
        await Promise.all([
            VoiceState.createQueryBuilder().delete().where(HOSTED_HERE).execute(),
            Stream.createQueryBuilder().delete().execute(),
            StageInstances.clear(),
            PrivateCalls.endStaleCalls(),
        ]).then(
            () => console.log("[Gateway] Cleared voice states, streams and calls"),
            (e) => console.error("[Gateway] Error clearing voice states, streams and calls on startup:", e),
        );
    })();
    return callStateCleanup;
}

// Temporary cleanup function until shutdown cleanup function is fixed.
// Currently when server is shut down the voice states are not cleared
// TODO: remove this when Server.stop() is fixed so that it waits for all websocket connections to run their
// respective Close event listener function for session cleanup
export async function cleanupOnStartup(): Promise<void> {
    // TODO: how is this different from clearing the table?
    //await VoiceState.update(
    //	{},
    //	{
    //		// @ts-expect-error channel_id is nullable
    //		channel_id: null,
    //		// @ts-expect-error guild_id is nullable
    //		guild_id: null,
    //		self_stream: false,
    //		self_video: false,
    //	},
    //);

    await clearCallStateOnStartup();

    if (presenceStopping || ProcessLifecycle.shutdownRequested) return;
    const singleProcess = !process.env.EVENT_TRANSMISSION && !RabbitMQ.connection;
    console.log("[Gateway] Starting async presence expiry...");
    expirePresences(singleProcess)
        .then((count) => console.log(`[Gateway] Marked ${count} leftover sessions offline`))
        .catch((e) => console.error("[Gateway] Error cleaning expired presence states on startup:", e));
}

let presenceStopping = false;
let presenceExpiry: Promise<number> | undefined;

ProcessLifecycle.eventEmitter.on("stopping", stopPresenceSweep);

export function expirePresences(all = false): Promise<number> {
    if (presenceStopping || ProcessLifecycle.shutdownRequested) return Promise.resolve(0);
    if (presenceExpiry) return presenceExpiry;
    const work = expirePresencesOnce(all).finally(() => {
        presenceExpiry = undefined;
    });
    presenceExpiry = work;
    return work;
}

async function expirePresencesOnce(all: boolean) {
    const query = Session.createQueryBuilder().update().set({ status: "offline", activities: [], client_status: {} }).where("status != 'offline'");
    if (!all)
        query.andWhere("(last_seen IS NULL OR last_seen < :since)", {
            since: new Date(Date.now() - PRESENCE_STALE_AFTER_MS),
        });
    const { raw } = await query.returning(["user_id"]).execute();
    const userIds = [...new Set((raw as { user_id: string }[]).map((x) => String(x.user_id)))];
    if (all) return userIds.length;
    for (const userId of userIds) {
        await emitSessionsReplace(userId).catch((e) => console.error(`[Gateway] failed to replace sessions for ${userId}`, e));
        await broadcastPresence(userId).catch((e) => console.error(`[Gateway] failed to broadcast presence for ${userId}`, e));
    }
    return userIds.length;
}

let presenceSweep: NodeJS.Timeout | undefined;
export function startPresenceSweep() {
    if (presenceSweep || presenceStopping || ProcessLifecycle.shutdownRequested) return;
    presenceSweep = setInterval(() => {
        void expirePresences().catch((e) => console.error("[Gateway] presence sweep failed", e));
    }, 15_000).unref();
}

export async function stopPresenceSweep() {
    presenceStopping = true;
    clearInterval(presenceSweep);
    presenceSweep = undefined;
    await Promise.allSettled([presenceExpiry]);
}

export async function handleOffloadedGatewayRequest(socket: WebSocket, url: string, body: unknown): Promise<boolean> {
    try {
        // TODO: async json object streaming
        const resp = await fetch(url, {
            body: JSON.stringify(body),
            method: "POST",
            headers: {
                Authorization: `Bearer ${socket.accessToken}`,
                // because the session may not have an id in the token!
                "X-Session-Id": socket.session_id,
                "Content-Type": "application/json",
            },
        });

        if (!resp.ok) {
            const text = await resp.text();
            console.error(`[Gateway] Offloaded request to ${url} failed with status ${resp.status}: ${text}`);
            if (resp.status === 415 || resp.status === 400) console.log(typeof body, body);
            // throw new Error(`Offloaded request failed with status ${resp.status}: ${text}`);
            return false;
        }

        const data = ((await resp.json()) as Event[]).toReversed();
        while (data.length > 0) {
            const event = data.pop()!;
            if (process.env.WS_VERBOSE) console.log(`[Gateway] Received offloaded event: ${JSON.stringify(event)}`);
            await Send(socket, {
                op: OPCODES.Dispatch,
                s: socket.sequence++,
                t: event.event,
                d: event.data,
            });
        }

        return true;
    } catch (e) {
        console.error("Error while handling offloaded gateway request:", e);
        return false;
    }
}
