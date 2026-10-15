/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { User } from "@spacebar/database";
import { cleanPreviousIds, Config, contactNames, isInstanceId, isPublicKey } from "@spacebar/util";
import { AdminFederationSettingsSchema } from "@spacebar/schemas";
import { announceSoon, instanceId, invalidateDirectory, refreshRegistry, resetRegistryState } from "@spacebar/api/util/utility/federation";
import { invalidateTrust } from "@spacebar/api/util/utility/federationNetwork";
import { announceOwnMoves, prepareOwnMoves } from "@spacebar/api/util/utility/federationMoves";
import { pickFederationSettings } from "./index";

const router = Router({ mergeParams: true });

router.patch(
    "/",
    route({
        right: "OPERATOR",
        spacebarOnly: true,
        requestBody: "AdminFederationSettingsSchema",
        description: "Change federation settings. The peer list replaces the stored list.",
    }),
    async (req: Request, res: Response) => {
        const body = req.body as AdminFederationSettingsSchema;
        const { federation } = Config.get();
        const registryChanged =
            (body.registryUrl !== undefined && body.registryUrl !== federation.registry.url) ||
            (body.registryPublicKey !== undefined && body.registryPublicKey !== federation.registry.publicKey);
        if (body.registryUrl !== undefined) {
            const url = body.registryUrl.trim().replace(/\/+$/, "");
            if (!/^https?:\/\//.test(url) || !URL.canParse(url)) throw new HTTPError("The registry URL must start with https://", 400);
            federation.registry.url = url;
        }
        if (body.registryPublicKey !== undefined) {
            if (!isPublicKey(body.registryPublicKey.trim())) throw new HTTPError("The registry key must be a 32-byte Ed25519 public key in base64url", 400);
            federation.registry.publicKey = body.registryPublicKey.trim();
        }
        if (body.peers !== undefined) {
            const peers = [
                ...new Set(
                    body.peers
                        .map((peer) =>
                            peer
                                .trim()
                                .toLowerCase()
                                .replace(/^https?:\/\//, "")
                                .replace(/\/.*$/, ""),
                        )
                        .filter(Boolean),
                ),
            ];
            const invalid = peers.find((peer) => !isInstanceId(peer));
            if (invalid) throw new HTTPError(`"${invalid}" isn't an instance id. Use the host name, with the port when it isn't 443.`, 400);
            federation.peers = peers;
        }
        const contactsChanged = body.contacts !== undefined && body.contacts.join("\n") !== federation.contacts.join("\n");
        if (body.contacts !== undefined) {
            const names = contactNames(body.contacts);
            const invalid = body.contacts.map((name) => name.trim().toLowerCase()).find((name) => name && !names.includes(name));
            if (invalid) throw new HTTPError(`"${invalid}" isn't a username. Use local usernames such as meow, one per line.`, 400);
            const found = names.length
                ? await User.find({
                      where: names.map((username) => ({ username, discriminator: "0", deleted: false, bot: false })),
                      select: { username: true, federated_instance: true },
                  })
                : [];
            const local = new Set(found.filter((user) => !user.federated_instance).map((user) => user.username));
            const unknown = names.find((name) => !local.has(name));
            if (unknown) throw new HTTPError(`There is no local account named "${unknown}".`, 400);
            federation.contacts = names;
        }
        const previousChanged = body.previousIds !== undefined && body.previousIds.join("\n") !== (federation.previousIds ?? []).join("\n");
        if (body.previousIds !== undefined) {
            const own = instanceId();
            const wanted = body.previousIds
                .map((id) =>
                    id
                        .trim()
                        .toLowerCase()
                        .replace(/^https?:\/\//, "")
                        .replace(/\/.*$/, ""),
                )
                .filter(Boolean);
            const cleaned = cleanPreviousIds(wanted, own);
            const invalid = wanted.find((id) => !cleaned.includes(id));
            if (invalid)
                throw new HTTPError(`"${invalid}" isn't a previous id of this instance. Use the old host name, with the port when it isn't 443, and not the current one.`, 400);
            federation.previousIds = cleaned;
        }
        if (body.enabled !== undefined) federation.enabled = body.enabled;
        if (body.announce !== undefined) federation.announce = body.announce;
        if (body.announceStats !== undefined) federation.announceStats = body.announceStats;
        if (body.allowUnlistedPeers !== undefined) federation.allowUnlistedPeers = body.allowUnlistedPeers;
        if (body.verification !== undefined) federation.discovery.verification = body.verification;
        await Config.set({ federation });
        if (registryChanged) await resetRegistryState();
        if (contactsChanged && federation.enabled && federation.announce) announceSoon();
        invalidateDirectory();
        invalidateTrust();
        if (previousChanged)
            prepareOwnMoves()
                .then(() => announceOwnMoves())
                .catch((error) => console.warn("[Federation] Sending the move statements after a settings change failed:", error));
        if (registryChanged || body.enabled || body.peers !== undefined || body.allowUnlistedPeers !== undefined || body.verification !== undefined)
            refreshRegistry().catch((error) => console.warn("[Federation] Refresh after a settings change failed:", error));
        res.json(pickFederationSettings());
    },
);

export default router;
