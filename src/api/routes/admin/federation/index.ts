/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { FederationPeer } from "@spacebar/database";
import { announceRefusal, Config, FederationKey, instancesJsonEntry } from "@spacebar/util";
import { announceContacts, currentDocument, federationStatus, instanceId, instanceUrl, wellKnownDocument } from "@spacebar/api/util/utility/federation";

const router = Router({ mergeParams: true });

export const pickFederationSettings = () => {
    const { federation } = Config.get();
    return {
        enabled: federation.enabled,
        registryUrl: federation.registry.url,
        registryPublicKey: federation.registry.publicKey,
        announce: federation.announce,
        announceStats: federation.announceStats ?? true,
        allowUnlistedPeers: federation.allowUnlistedPeers,
        peers: [...federation.peers],
        contacts: [...(federation.contacts ?? [])],
        previousIds: [...(federation.previousIds ?? [])],
        verification: federation.discovery.verification,
    };
};

router.get(
    "/",
    route({
        right: "OPERATOR",
        spacebarOnly: true,
        description: "Federation settings, this instance's identity, the registry sync and announce state, and peer fetch results",
    }),
    async (req: Request, res: Response) => {
        const id = instanceId();
        const wellKnown = wellKnownDocument();
        const [status, document, peers, contacts] = await Promise.all([
            federationStatus(),
            currentDocument(),
            FederationPeer.find({ order: { id: "ASC" } }),
            id && !announceRefusal(id) ? announceContacts(id) : Promise.resolve([]),
        ]);
        res.json({
            settings: pickFederationSettings(),
            instance: {
                id,
                url: instanceUrl(),
                public_key: FederationKey.ready ? FederationKey.publicKey : null,
                announce_refusal: announceRefusal(id),
                contacts,
                listed: !!document?.instances.some((instance) => instance.id === id),
                registry_entry: document?.instances.find((instance) => instance.id === id) ?? null,
                instances_json: wellKnown ? instancesJsonEntry(wellKnown, "https://github.com/meowcorded/meowcord") : null,
            },
            status,
            counts: document
                ? {
                      instances: document.instances.length,
                      discovery: document.discovery.length,
                      blocked_instances: document.blocked.instances.length,
                      blocked_guilds: document.blocked.guilds.length,
                      blocked_users: document.blocked.users.length,
                  }
                : null,
            peers: peers.map((peer) => ({
                id: peer.id,
                fetched_at: peer.fetched_at,
                error: peer.error,
                pinned_key: peer.public_key,
                guilds: peer.discovery ? (JSON.parse(peer.discovery) as unknown[]).length : 0,
            })),
        });
    },
);

export default router;
