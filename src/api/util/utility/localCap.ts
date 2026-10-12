import { sqlReturning } from "@spacebar/database/Sql";
import { createHash, createHmac } from "node:crypto";
import { RateLimit } from "@spacebar/database";
import { Config } from "@spacebar/util";
import type { ValidateChallengeBody } from "capjs-core";
import { judgeAutomation, tokenHasInstrumentation, withAutomationSignals } from "./automationSignals";

export const CAP_CONTEXTS = ["register", "login", "password_reset"] as const;
export type CapContext = (typeof CAP_CONTEXTS)[number];

export const CAP_CHALLENGE_BOUNDS = {
    count: { min: 1, max: 500 },
    size: { min: 16, max: 64 },
    difficulty: { min: 1, max: 8 },
};

export const isCapContext = (value: unknown): value is CapContext => CAP_CONTEXTS.includes(value as CapContext);

const scopeOf = (context: CapContext) => (context === "register" ? "fosscord-registration" : `fosscord-${context.replace("_", "-")}`);
const tokenKey = (token: string, context: CapContext) => `cap-token:${context === "register" ? "" : `${context}:`}${createHash("sha256").update(token).digest("hex")}`;
const signingKey = (context: CapContext) => createHmac("sha256", Config.get().security.requestSignature).update(scopeOf(context)).digest("hex");
const acceptedKeys = (token: string, context: CapContext) => [...new Set([tokenKey(token, context), tokenKey(token, "register")])];

const clamp = (value: unknown, { min, max }: { min: number; max: number }, fallback: number) =>
    typeof value === "number" && Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;

export function capChallengeParameters(context: CapContext) {
    const { challenges } = Config.get().security.captcha;
    const configured = (context === "password_reset" ? challenges?.passwordReset : challenges?.[context]) ?? {};
    return {
        challengeCount: clamp(configured.count, CAP_CHALLENGE_BOUNDS.count, 64),
        challengeSize: clamp(configured.size, CAP_CHALLENGE_BOUNDS.size, 32),
        challengeDifficulty: clamp(configured.difficulty, CAP_CHALLENGE_BOUNDS.difficulty, 5),
    };
}

export const blockingAutomatedBrowsers = () => Config.get().security.captcha.blockAutomatedBrowsers !== false;

export async function createRegistrationChallenge(context: CapContext = "register") {
    const { generateChallenge } = await import("capjs-core");
    const blockAutomatedBrowsers = blockingAutomatedBrowsers();
    const challenge = await generateChallenge(signingKey(context), {
        scope: scopeOf(context),
        ...capChallengeParameters(context),
        instrumentation: { blockAutomatedBrowsers, obfuscationLevel: 1 },
        expiresMs: 300_000,
    });
    if (blockAutomatedBrowsers && "instrumentation" in challenge && challenge.instrumentation) challenge.instrumentation = withAutomationSignals(challenge.instrumentation);
    return challenge;
}

export async function redeemRegistrationChallenge(body: unknown, context: CapContext = "register") {
    if (!body || typeof body !== "object" || Array.isArray(body) || JSON.stringify(body).length > 16_384) return { success: false, reason: "invalid_body" };
    const { validateChallenge } = await import("capjs-core");
    const submitted = body as ValidateChallengeBody;
    const result = await validateChallenge(signingKey(context), submitted, {
        scope: scopeOf(context),
        tokenTtlMs: 300_000,
        consumeNonce: async (signature, ttl) => {
            const rows = await RateLimit.query(
                `INSERT INTO rate_limits (id, executor_id, hits, blocked, expires_at) VALUES ($1, 'cap', 0, false, $2)
                 ON CONFLICT (id) DO NOTHING RETURNING id`,
                [`cap-nonce:${signature}`, new Date(Date.now() + ttl)],
            );
            return rows.length === 1;
        },
    });
    if (!result.success) return { success: false, reason: result.reason };
    if (blockingAutomatedBrowsers() && tokenHasInstrumentation(submitted.token)) {
        const verdict = judgeAutomation(submitted.instr?.p);
        if (verdict.automated) {
            console.log(`[Cap] refused an automated browser for ${context}: ${verdict.reasons.join(", ")}`);
            return { success: false, reason: "automated_browser" };
        }
    }
    await RateLimit.query(`INSERT INTO rate_limits (id, executor_id, hits, blocked, expires_at) VALUES ($1, 'cap', 0, false, $2)`, [
        tokenKey(result.token, context),
        new Date(result.expires),
    ]);
    return { success: true, token: result.token, expires: result.expires };
}

const placeholders = (count: number, offset = 0) => Array.from({ length: count }, (_, index) => `$${index + offset + 1}`).join(", ");

export async function consumeRegistrationToken(token: string, context: CapContext = "register") {
    if (!token || token.length > 512) return false;
    const keys = acceptedKeys(token, context);
    const rows = await RateLimit.query(sqlReturning(`DELETE FROM rate_limits WHERE id IN (${placeholders(keys.length)}) AND expires_at > $${keys.length + 1} RETURNING id`), [
        ...keys,
        new Date(),
    ]);
    return rows.length >= 1;
}

export async function registrationTokenAvailable(token: string, context: CapContext = "register") {
    if (!token || token.length > 512) return false;
    const keys = acceptedKeys(token, context);
    const rows = await RateLimit.query(`SELECT 1 FROM rate_limits WHERE id IN (${placeholders(keys.length)}) AND expires_at > $${keys.length + 1} LIMIT 1`, [...keys, new Date()]);
    return rows.length === 1;
}
