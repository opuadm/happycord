/* SPDX-License-Identifier: AGPL-3.0-only */
import crypto from "node:crypto";
import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { Config } from "@spacebar/util";
import { AdminAutomodSettingsSchema } from "@spacebar/schemas";
import { pickAutomodSettings } from "./index";

const router = Router({ mergeParams: true });

const cleanTerms = (terms: string[], label: string, max: number) => {
    const cleaned = [...new Set(terms.map((term) => term.trim()).filter(Boolean))];
    if (cleaned.length > max || cleaned.some((term) => term.length > 64)) throw new HTTPError(`${label} can hold up to ${max} entries of up to 64 characters each`, 400);
    return cleaned;
};

router.patch(
    "/",
    route({
        right: "MANAGE_USERS",
        spacebarOnly: true,
        requestBody: "AdminAutomodSettingsSchema",
        description: "Save one or more automod sections. Lists replace the stored list.",
    }),
    async (req: Request, res: Response) => {
        const body = req.body as AdminAutomodSettingsSchema;
        const config = Config.get();
        const { automod, register, user } = config;

        if (body.identityBlockedTerms !== undefined) {
            const terms = cleanTerms(body.identityBlockedTerms, "Blocked name words", 256);
            if (terms.some((term) => !/^[\p{L}\p{N}]+$/u.test(term))) throw new HTTPError("Blocked name words can only contain letters and numbers", 400);
            user.identityBlockedTerms = terms;
        }
        if (body.wordLists !== undefined) {
            const ids = new Set<string>();
            automod.wordLists = body.wordLists.map((list) => {
                const id = list.id && /^[\w-]{1,64}$/.test(list.id) && !ids.has(list.id) ? list.id : crypto.randomUUID();
                ids.add(id);
                if (!list.name.trim()) throw new HTTPError("Give every word list a name", 400);
                return {
                    id,
                    name: list.name.trim().slice(0, 64),
                    terms: cleanTerms(list.terms, `The "${list.name.trim()}" list`, 500),
                    action: list.action,
                    suspendDays: Math.min(Math.max(Math.round(list.suspendDays ?? 7), 1), 365),
                };
            });
        }
        if (body.allowList !== undefined) automod.allowList = cleanTerms(body.allowList, "The allow list", 500).map((entry) => entry.slice(0, 200));
        if (body.slurs) Object.assign(automod.slurs, body.slurs);
        if (body.login) Object.assign(automod.login, body.login);
        if (body.registration) {
            const { joinReasonRequired, joinReasonMinLength, requireApproval, maxAccountsPerIpPerDay } = body.registration;
            if (joinReasonRequired !== undefined) register.joinReason.required = joinReasonRequired;
            if (joinReasonMinLength !== undefined) register.joinReason.minLength = Math.min(joinReasonMinLength, register.joinReason.maxLength);
            if (requireApproval !== undefined) register.requireApproval = requireApproval;
            if (maxAccountsPerIpPerDay !== undefined) automod.registration.maxAccountsPerIpPerDay = maxAccountsPerIpPerDay;
        }
        await Config.set({ automod, register, user });
        res.json(pickAutomodSettings());
    },
);

export default router;
