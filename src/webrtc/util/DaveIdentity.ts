/* SPDX-License-Identifier: AGPL-3.0-only */
import { FederatedObject, User } from "@spacebar/database";
import { parseCanonicalId } from "@spacebar/util";
import type { WebRtcWebSocket } from "./WebRtcWebSocket";

const U64_LIMIT = 1n << 64n;

export async function daveIdOf(user_id: string) {
    const user = await User.findOne({ where: { id: user_id }, select: { id: true, federated_instance: true } });
    if (!user?.federated_instance) return user_id;
    const row = await FederatedObject.findOne({ where: { local_id: user_id }, select: { canonical: true, local_id: true } });
    const canonical = parseCanonicalId(row?.canonical);
    if (!canonical || canonical.instance !== user.federated_instance || BigInt(canonical.id) >= U64_LIMIT) return null;
    return BigInt(canonical.id).toString();
}

export const daveIds = (sockets: WebRtcWebSocket[], receiver: WebRtcWebSocket) => {
    const entries = sockets.flatMap((socket) =>
        socket.daveId && (receiver.federation || socket.daveId !== socket.user_id) ? [{ user_id: socket.user_id, dave: socket.daveId }] : [],
    );
    return entries.length ? { meowcord_dave: entries } : {};
};
