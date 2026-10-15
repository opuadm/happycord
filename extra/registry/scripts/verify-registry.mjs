import { verifyEnvelope } from "../src/crypto.js";

const url = process.argv[2] ?? "https://meowcord-registry.tiag.workers.dev/v1/registry";
const publicKey = process.argv[3] ?? "f0jm9Szfa52pkT0nWkeZK4D1wa3NUZ9hceWaFQLZYrk";

const response = await fetch(url);
if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
const { keyId, payload } = await verifyEnvelope(await response.json(), publicKey);
const problems = [];
if (keyId !== "registry-1") problems.push(`key_id is ${keyId}`);
if (payload.version !== 1) problems.push(`version is ${payload.version}`);
if (Date.parse(payload.expires_at) <= Date.now()) problems.push("the document expired");
if (Date.parse(payload.expires_at) - Date.parse(payload.issued_at) !== 7 * 24 * 60 * 60 * 1000) problems.push("expires_at is not 7 days after issued_at");
console.log(`signature verifies against ${publicKey}`);
console.log(`sequence ${payload.sequence}, issued ${payload.issued_at}, expires ${payload.expires_at}`);
console.log(`${payload.instances.length} instances, ${payload.discovery.length} discovery servers`);
console.log(`blocked: ${payload.blocked.instances.length} instances, ${payload.blocked.guilds.length} servers, ${payload.blocked.users.length} users`);
if (problems.length) {
    console.error(problems.join("\n"));
    process.exit(1);
}
