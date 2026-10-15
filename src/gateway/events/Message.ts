import { Payload, WebSocket } from "@spacebar/gateway";
import { CLOSECODES, OPCODES } from "../util/Constants";
import * as erlpack from "harmony-erlpack";
import fs from "node:fs/promises";
import BigIntJson from "json-bigint";
import path from "node:path";
import WS from "ws";
import OPCodeHandlers from "../opcodes";
import { check } from "../opcodes/instanceOf";
import { PayloadSchema } from "@spacebar/schemas";
import { HTTPError } from "lambert-server";

const bigIntJson = BigIntJson({ storeAsString: true });

function jsonSafe(value: unknown): unknown {
    if (typeof value === "bigint") return value.toString();
    if (Array.isArray(value)) return value.map(jsonSafe);
    if (value && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null))
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonSafe(v)]));
    return value;
}
const CommandWindow = 60_000;
const CommandLimit = 120;
const FrameLimit = 240;
const UnauthenticatedOpcodes = new Set<number>([OPCODES.Heartbeat, OPCODES.Identify, OPCODES.Resume, OPCODES.SetQoS]);
const AuthenticatingOpcodes = new Set<number>([OPCODES.Identify, OPCODES.Resume]);

export async function Message(this: WebSocket, buffer: WS.Data) {
    let data: Payload;

    const frameTime = Date.now();
    if (!this.frameWindow || frameTime - this.frameWindow.start >= CommandWindow) this.frameWindow = { start: frameTime, count: 0 };
    if (++this.frameWindow.count > FrameLimit) return this.close(CLOSECODES.Rate_limited, "Rate limited.");

    try {
        if (
            (Buffer.isBuffer(buffer) && buffer[0] === 123) || // ASCII 123 = `{`. Bad check for JSON
            typeof buffer === "string"
        ) {
            data = bigIntJson.parse(buffer.toString());
        } else if (this.encoding === "json" && Buffer.isBuffer(buffer)) {
            data = bigIntJson.parse(buffer.toString("utf8"));
        } else if (this.encoding === "etf" && Buffer.isBuffer(buffer) && erlpack) {
            try {
                // cast is ~safe: unpack returns the parsed data in the shape it was provided, @yukikaze-bot/erlpack got around this by returning `any` instead of an actual type union.
                data = jsonSafe(erlpack.unpack(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))) as unknown as Payload;
            } catch {
                console.error(`[Gateway/${this.user_id ?? this.ipAddress}] Failed to decode ETF payload`);
                return this.close(CLOSECODES.Decode_error);
            }
        } else {
            console.error(`[Gateway/${this.user_id ?? this.ipAddress}] Unknown payload format`);
            return this.close(CLOSECODES.Decode_error);
        }

        check.call(this, PayloadSchema, data);
    } catch {
        if (this.readyState === WS.OPEN) this.close(CLOSECODES.Decode_error);
        return;
    }

    let ownsAuthentication = false;
    try {
        if (process.env.WS_VERBOSE) console.log(`[Websocket] Incomming message: ${JSON.stringify(data)}`);

        if (process.env.WS_DUMP) {
            const id = this.session_id || "unknown";

            await fs.mkdir(path.join("dump", id), { recursive: true });
            await fs.writeFile(path.join("dump", id, `${Date.now()}.in.json`), JSON.stringify(data, null, 2));

            if (!this.session_id) console.log(`[Gateway/${this.user_id ?? this.ipAddress}] Unknown session id, dumping to unknown folder`);
        }

        if (data.op !== OPCODES.Heartbeat && data.op !== OPCODES.SetQoS) {
            const now = Date.now();
            if (!this.commandWindow || now - this.commandWindow.start >= CommandWindow) this.commandWindow = { start: now, count: 0 };
            if (++this.commandWindow.count > CommandLimit) return this.close(CLOSECODES.Rate_limited, "Rate limited.");
        }

        if (!this.user_id && !UnauthenticatedOpcodes.has(data.op)) return this.close(CLOSECODES.Not_authenticated, "Not authenticated.");
        if (AuthenticatingOpcodes.has(data.op)) {
            if (this.authenticating || this.user_id) return this.close(CLOSECODES.Already_authenticated, "Already authenticated.");
            this.authenticating = true;
            ownsAuthentication = true;
        }

        const OPCodeHandler = OPCodeHandlers[data.op];
        if (!OPCodeHandler) {
            console.error(`[Gateway/${this.user_id ?? this.ipAddress}] Unknown opcode`, data.op);
            // TODO: if all opcodes are implemented comment this out:
            // this.close(CLOSECODES.Unknown_opcode);
            return;
        }

        return await OPCodeHandler.call(this, data);
    } catch (error) {
        console.error(`[Gateway/${this.user_id ?? this.ipAddress}] Error: Op ${data.op}`, error);
        let message: string | undefined;
        if (error instanceof HTTPError) message = error.message;
        if (data.op === 2 && error instanceof HTTPError && error.code >= 400 && error.code < 500) return this.close(CLOSECODES.Authentication_failed, "Authentication failed.");
        // if (!this.CLOSED && this.CLOSING)
        return this.close(CLOSECODES.Unknown_error, message ?? `Error while handling opcode ${data.op}`);
    } finally {
        if (ownsAuthentication) this.authenticating = false;
    }
}
