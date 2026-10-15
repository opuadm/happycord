const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export const REGISTRY_KEY_ID = "registry-1";

export function toBase64Url(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function fromBase64Url(text) {
    if (typeof text !== "string" || !/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("invalid base64url");
    const padded = text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

export function randomBase64Url(length) {
    return toBase64Url(crypto.getRandomValues(new Uint8Array(length)));
}

export async function sha256Hex(text) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
    return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Base64Url(text) {
    return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))));
}

const pkcs8Prefix = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

export async function importSigningSeed(seedBase64Url) {
    const seed = fromBase64Url(seedBase64Url?.trim() ?? "");
    if (seed.length !== 32) throw new Error("REGISTRY_SIGNING_KEY must be a 32-byte base64url seed");
    const pkcs8 = new Uint8Array(pkcs8Prefix.length + 32);
    pkcs8.set(pkcs8Prefix);
    pkcs8.set(seed, pkcs8Prefix.length);
    const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
    const { x } = await crypto.subtle.exportKey("jwk", privateKey);
    return { privateKey, publicKey: x };
}

export async function signEnvelope(payload, privateKey, keyId) {
    const bytes = encoder.encode(JSON.stringify(payload));
    const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, bytes));
    return { payload: toBase64Url(bytes), signature: toBase64Url(signature), key_id: keyId };
}

export async function verifyEnvelope(envelope, publicKeyBase64Url) {
    if (!envelope || typeof envelope !== "object") throw new Error("envelope is not an object");
    const { payload, signature, key_id } = envelope;
    if (typeof payload !== "string" || typeof signature !== "string" || typeof key_id !== "string") throw new Error("envelope is missing payload, signature or key_id");
    const rawKey = fromBase64Url(publicKeyBase64Url);
    if (rawKey.length !== 32) throw new Error("public key is not 32 bytes");
    const signatureBytes = fromBase64Url(signature);
    if (signatureBytes.length !== 64) throw new Error("signature is not 64 bytes");
    const payloadBytes = fromBase64Url(payload);
    const key = await crypto.subtle.importKey("raw", rawKey, { name: "Ed25519" }, false, ["verify"]);
    if (!(await crypto.subtle.verify({ name: "Ed25519" }, key, signatureBytes, payloadBytes))) throw new Error("signature does not verify");
    return { keyId: key_id, payload: JSON.parse(decoder.decode(payloadBytes)) };
}

export function decodeEnvelopePayload(envelope) {
    if (typeof envelope?.payload !== "string") throw new Error("envelope has no payload");
    return JSON.parse(decoder.decode(fromBase64Url(envelope.payload)));
}

export function isPublicKey(value) {
    try {
        return fromBase64Url(value).length === 32;
    } catch {
        return false;
    }
}
