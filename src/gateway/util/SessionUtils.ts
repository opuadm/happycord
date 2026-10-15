import { randomBytes } from "node:crypto";

export function genSessionId() {
    return genRanHex(32);
}

export function genVoiceToken() {
    return genRanHex(16);
}

function genRanHex(size: number) {
    return randomBytes(Math.ceil(size / 2))
        .toString("hex")
        .slice(0, size);
}
