/* SPDX-License-Identifier: AGPL-3.0-only */
import definePlugin, { StartAt } from "@utils/types";
import { useEffect, useState } from "@webpack/common";

import { FosscordAuthor } from "../fosscordCore/shared";
import managedStyle from "./style.css?managed";

type JoinReasonEnv = { required: boolean; minLength: number; maxLength: number; approval: boolean };
type Feedback = { code: string; message: string } | null;
type FieldError = { code?: string; message?: string };

const environment = () => (window as unknown as { GLOBAL_ENV?: { REGISTER_JOIN_REASON?: JoinReasonEnv | null } }).GLOBAL_ENV?.REGISTER_JOIN_REASON ?? null;

let reason = "";
let feedback: Feedback = null;
const listeners = new Set<(feedback: Feedback) => void>();
const publish = (next: Feedback) => {
    feedback = next;
    for (const listener of listeners) listener(next);
};

function JoinReasonField() {
    const settings = environment();
    const [value, setValue] = useState(reason);
    const [shown, setShown] = useState<Feedback>(feedback);
    useEffect(() => {
        listeners.add(setShown);
        return () => void listeners.delete(setShown);
    }, []);
    useEffect(() => {
        reason = value;
    }, [value]);
    if (!settings) return null;
    const length = value.trim().length;
    const pending = shown?.code === "ACCOUNT_PENDING_APPROVAL";
    const short = settings.required && length < settings.minLength;
    return (
        <section className="fosscord-join-reason">
            <label className="fosscord-join-reason-label" htmlFor="fosscord-join-reason">
                <span>Why do you want to join?</span>
                {settings.required ? (
                    <span className="fosscord-join-reason-required" aria-hidden="true">
                        *
                    </span>
                ) : (
                    <span className="fosscord-join-reason-optional">Optional</span>
                )}
            </label>
            <p id="fosscord-join-reason-hint" className="fosscord-join-reason-hint">
                {settings.approval
                    ? "A moderator reads this before your account can be used. Say how you found this server and what you want to do here."
                    : "Moderators read this to keep spam accounts out. Say how you found this server and what you want to do here."}
            </p>
            <textarea
                id="fosscord-join-reason"
                className="fosscord-join-reason-input"
                rows={3}
                maxLength={settings.maxLength}
                required={settings.required}
                aria-required={settings.required}
                aria-invalid={!!shown && !pending}
                aria-describedby={`fosscord-join-reason-hint fosscord-join-reason-count${shown ? " fosscord-join-reason-feedback" : ""}`}
                value={value}
                onChange={(event) => {
                    setValue(event.currentTarget.value);
                    if (shown && !pending) publish(null);
                }}
            />
            <p id="fosscord-join-reason-count" className="fosscord-join-reason-count" data-short={short || undefined}>
                {settings.required ? (short ? `${length} of at least ${settings.minLength} characters` : `${length} characters`) : `${length} characters`}
            </p>
            {shown && (
                <p id="fosscord-join-reason-feedback" className={pending ? "fosscord-join-reason-pending" : "fosscord-join-reason-error"} role={pending ? "status" : "alert"}>
                    {shown.message}
                </p>
            )}
        </section>
    );
}

export default definePlugin({
    name: "FosscordJoinReason",
    description: "Asks new accounts why they want to join on the signup form when the instance requires a reason or approves accounts by hand.",
    authors: [FosscordAuthor],
    required: true,
    managedStyle,
    startAt: StartAt.DOMContentLoaded,
    renderField: () => <JoinReasonField key="fosscord-join-reason" />,
    takeReason: () => (environment() ? reason.trim() : undefined),
    captureError(error: { body?: { errors?: { join_reason?: { _errors?: FieldError[] } } } }) {
        const first = error?.body?.errors?.join_reason?._errors?.[0];
        publish(first?.message ? { code: first.code ?? "", message: first.message } : null);
        throw error;
    },
    patches: [
        {
            find: "REGISTER_PROMO_EMAIL_CHECKBOX_WEB",
            replacement: [
                {
                    match: /\(0,\i\.jsx\)\(\i,\{consent:\i,consentRequired:\i,onConsentChange:\i\}\)/g,
                    replace: "$self.renderField(),$&",
                },
                {
                    match: /url:\i\.\i\.REGISTER,body:\{/,
                    replace: "$&join_reason:$self.takeReason(),",
                },
                {
                    match: /(url:\i\.\i\.REGISTER,body:\{[\s\S]{0,1500}?rejectWithError:!1\}\))\.then\(/,
                    replace: "$1.catch($self.captureError).then(",
                },
            ],
        },
    ],
});
