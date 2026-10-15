/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { In } from "typeorm";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { InstanceBan, RaidIncident, Session, User } from "@spacebar/database";
import { AdminRaidIncidentActionSchema } from "@spacebar/schemas";
import { applySpamAction, blockFederatedUser, canActOn, deleteAuthoredMessages, endUserSessions, ipVariants, normalizeIp, recordAutomodAction } from "@spacebar/api/util";
import { serializeIncidents } from "../index";
import { findIncident } from "./index";

const router = Router({ mergeParams: true });

const BATCH = 100;

router.post(
    "/",
    route({
        right: "MODERATE_USERS",
        spacebarOnly: true,
        requestBody: "AdminRaidIncidentActionSchema",
        description:
            "Act on every account in an incident, or on `user_ids` from it: delete every message they sent, suspend them, disable them or ban the IP addresses they registered and signed in from. Accounts from other instances are blocked from federating instead of suspended, disabled or IP banned. Your own account and staff at or above your own role are skipped.",
    }),
    async (req: Request, res: Response) => {
        const body = req.body as AdminRaidIncidentActionSchema;
        const incident = await findIncident(req.params.incident_id as string);
        if (body.action === "delete_messages" && !req.rights.has("MANAGE_MESSAGES")) throw new HTTPError("Deleting their messages needs the MANAGE_MESSAGES right", 403);
        const members = incident.user_ids ?? [];
        const wanted = body.user_ids?.length ? body.user_ids.filter((id) => members.includes(id)) : members;
        if (!wanted.length) throw new HTTPError("Nobody in this incident matches", 400);
        const reason = body.reason?.trim() || `Raid response from the admin dashboard by ${req.user?.username ?? req.user_id}`;

        const users = await User.find({ where: { id: In(wanted) }, select: { id: true, username: true, rights: true, federated_instance: true, registration_ip: true } });
        const skipped: { id: string; reason: "unknown" | "self" | "operator" }[] = [];
        const targets: User[] = [];
        for (const id of wanted) {
            const user = users.find((entry) => entry.id === id);
            if (!user) skipped.push({ id, reason: "unknown" });
            else if (id === req.user_id) skipped.push({ id, reason: "self" });
            else if (!canActOn({ id: req.user_id, rights: req.rights.bitfield }, user)) skipped.push({ id, reason: "operator" });
            else targets.push(user);
        }

        let messages_deleted = 0;
        let federation_blocked = 0;
        const ips_banned: string[] = [];
        const ips_skipped: { ip: string; reason: "self" | "already_banned" | "shared" }[] = [];
        const ids = targets.map((user) => user.id);
        for (let start = 0; start < ids.length; start += BATCH) {
            const batch = targets.slice(start, start + BATCH);
            if (body.action === "delete_messages") {
                messages_deleted += await deleteAuthoredMessages(batch.map((user) => user.id));
                continue;
            }
            if (body.action === "suspend" || body.action === "disable") {
                for (const user of batch) {
                    const result = await applySpamAction(user, body.action, { guild_ids: [], reason, actor_id: req.user_id });
                    if (result.taken === "federation_block") federation_blocked++;
                    await recordAutomodAction({
                        user_id: user.id,
                        username: user.username,
                        rule: incident.kind,
                        source: "admin",
                        action: result.taken,
                        text: reason,
                        guild_id: incident.guild_id,
                        suspended_until: result.until,
                        incident_id: incident.id,
                    });
                }
                continue;
            }
            const remote = batch.filter((user) => user.federated_instance);
            for (const user of remote) {
                await blockFederatedUser(user.id, reason, req.user_id);
                federation_blocked++;
            }
            const local = batch.filter((user) => !user.federated_instance);
            const sessions = local.length ? await Session.find({ where: { user_id: In(local.map((user) => user.id)) }, select: { session_id: true, last_seen_ip: true } }) : [];
            const own = normalizeIp(req.ip);
            const ips = [
                ...new Set(
                    [...local.map((user) => normalizeIp(user.registration_ip)), ...sessions.map((session) => normalizeIp(session.last_seen_ip))].filter((ip): ip is string => !!ip),
                ),
            ];
            for (const ip of ips) {
                if (own && ipVariants(ip).includes(own)) {
                    ips_skipped.push({ ip, reason: "self" });
                    continue;
                }
                if (InstanceBan.sharedAddress(ip)) {
                    ips_skipped.push({ ip, reason: "shared" });
                    continue;
                }
                if (await InstanceBan.exists({ where: ipVariants(ip).map((variant) => ({ ip_address: variant, is_allowlisted: false })) })) {
                    ips_skipped.push({ ip, reason: "already_banned" });
                    continue;
                }
                await InstanceBan.create({ ip_address: ip, reason }).save();
                ips_banned.push(ip);
            }
            await endUserSessions(
                local.map((user) => user.id),
                "IP address banned",
            );
            for (const user of batch)
                await recordAutomodAction({
                    user_id: user.id,
                    username: user.username,
                    rule: incident.kind,
                    source: "admin",
                    action: user.federated_instance ? "federation_block" : "ban",
                    text: reason,
                    guild_id: incident.guild_id,
                    incident_id: incident.id,
                });
        }

        incident.actions = [
            ...(incident.actions ?? []),
            {
                action: body.action,
                by: req.user_id,
                at: new Date().toISOString(),
                processed: targets.length,
                skipped: skipped.length,
                ...(body.action === "delete_messages" ? { messages_deleted } : {}),
                ...(body.action === "ban_ip" ? { ips_banned: ips_banned.length } : {}),
            },
        ];
        await RaidIncident.update({ id: incident.id }, { actions: incident.actions });
        console.log(`[Admin] User ${req.user_id} ran ${body.action} on ${targets.length} account(s) of incident ${incident.id}: ${ids.join(", ")}`);
        const [serialized] = await serializeIncidents([incident]);
        res.json({ processed: ids, skipped, messages_deleted, federation_blocked, ips_banned, ips_skipped, incident: serialized });
    },
);

export default router;
