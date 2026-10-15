/* SPDX-License-Identifier: AGPL-3.0-only */
import { createHmac, randomBytes } from "node:crypto";
import { Config, FieldErrors } from "@spacebar/util";
import { emailDomainOf, isDeniedEmail, scoreSignup, SignupTracker } from "@spacebar/util/util/SignupSignals";
import { recordAutomodAction } from "./instanceAutomod";
import { captchaSolveTime } from "./localCap";
import { rulePolicy } from "./automodPolicy";

const PASSWORD_KEY = randomBytes(32);

export const signupTracker = new SignupTracker();

export const signupPasswordKey = (password: string) => createHmac("sha256", PASSWORD_KEY).update(password, "utf8").digest("hex").slice(0, 16);

export type SignupAssessment = ReturnType<typeof scoreSignup> & { summary: string; wouldAction?: "hold" | "refuse" };

const summarize = (result: ReturnType<typeof scoreSignup>) => `score ${result.score}: ${result.signals.map((signal) => signal.detail).join(", ")}`.slice(0, 200);

export async function assessSignup(input: {
    username: string;
    email?: string | null;
    passwordKey?: string | null;
    captchaToken?: string | null;
}): Promise<SignupAssessment | null> {
    const config = Config.get().automod.signup;
    if (!config.enabled) return null;
    if (isDeniedEmail(input.email, config.deniedEmailDomains)) {
        await recordAutomodAction({
            username: input.username.slice(0, 64),
            rule: "signup_bot",
            term: `email domain ${emailDomainOf(input.email)} is denied`,
            source: "registration",
            action: "block",
        }).catch(() => undefined);
        throw FieldErrors({ email: { code: "EMAIL_DOMAIN_NOT_ALLOWED", message: "This instance doesn't accept signups from this email provider. Use another email address." } });
    }
    const signup = { username: input.username, email: input.email, passwordKey: input.passwordKey, solveMs: captchaSolveTime(input.captchaToken) };
    const scored = scoreSignup(signup, config, signupTracker);
    signupTracker.record(signup, config);
    const dryRun = rulePolicy("signupBot").dryRun && (scored.verdict === "hold" || scored.verdict === "refuse");
    const result = dryRun ? { ...scored, verdict: "log" as const } : scored;
    const assessment: SignupAssessment = { ...result, summary: summarize(result), wouldAction: dryRun ? (scored.verdict as "hold" | "refuse") : undefined };
    if (result.verdict === "refuse") {
        await recordAutomodAction({ username: input.username.slice(0, 64), rule: "signup_bot", term: assessment.summary, source: "registration", action: "block" }).catch(
            () => undefined,
        );
        throw FieldErrors({
            username: { code: "SIGNUP_REFUSED", message: "This signup looks automated, so this instance refused it. Contact the instance staff if you think this is a mistake." },
        });
    }
    return assessment;
}

export async function logSignupAssessment(user: { id: string; username: string }, assessment: SignupAssessment | null) {
    if (!assessment || (assessment.verdict !== "log" && assessment.verdict !== "hold")) return;
    await recordAutomodAction({
        user_id: user.id,
        username: user.username,
        rule: "signup_bot",
        term: assessment.summary,
        source: "registration",
        action: assessment.verdict === "hold" ? "hold" : "log",
        would_action: assessment.wouldAction === "refuse" ? "block" : (assessment.wouldAction ?? null),
    }).catch((error) => console.error("[Automod] couldn't log a signup", error));
}
