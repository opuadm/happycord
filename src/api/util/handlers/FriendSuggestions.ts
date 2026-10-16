/* SPDX-License-Identifier: AGPL-3.0-only */
import { In } from "typeorm";
import { Relationship, User } from "@spacebar/database";
import { RelationshipType, PublicUserProjection } from "@spacebar/schemas";

export const FRIEND_SUGGESTION_LIMIT = 25;

export type FriendSuggestionCandidate = { id: string; mutual_friends_count: number };

export async function suggestionCandidates(userId: string, limit = FRIEND_SUGGESTION_LIMIT): Promise<FriendSuggestionCandidate[]> {
    const rows = await Relationship.query(
        `SELECT r2."to_id" AS id, COUNT(*) AS mutual_friends_count
         FROM relationships r1
         INNER JOIN relationships r2 ON r2."from_id" = r1."to_id" AND r2."type" = $2
         WHERE r1."from_id" = $1 AND r1."type" = $2
         AND r2."to_id" <> $1
         AND NOT EXISTS (SELECT 1 FROM relationships mine WHERE mine."from_id" = $1 AND mine."to_id" = r2."to_id")
         AND NOT EXISTS (SELECT 1 FROM relationships blocked WHERE blocked."from_id" = r2."to_id" AND blocked."to_id" = $1 AND blocked."type" = $3)
         AND NOT EXISTS (SELECT 1 FROM friend_suggestion_dismissals d WHERE d."user_id" = $1 AND d."dismissed_id" = r2."to_id")
         GROUP BY r2."to_id"
         ORDER BY mutual_friends_count DESC, id ASC
         LIMIT $4`,
        [userId, RelationshipType.FRIEND, RelationshipType.BLOCKED, limit],
    );
    const ids = rows.map((row: { id: string }) => String(row.id));
    if (!ids.length) return [];
    const users = await User.find({
        where: { id: In(ids), bot: false, deleted: false },
        select: Object.fromEntries(PublicUserProjection.map((key) => [key, true])),
    });
    const byId = new Map(users.map((user) => [user.id, user]));
    return rows
        .map((row: { id: string; mutual_friends_count: string }) => ({ user: byId.get(String(row.id)), mutual_friends_count: Number(row.mutual_friends_count) }))
        .filter((entry: { user?: User }) => !!entry.user)
        .map((entry: { user: User; mutual_friends_count: number }) => ({
            suggested_user: entry.user.toPublicUser(),
            reasons: [{ name: "Mutual friends" }],
            mutual_friends_count: entry.mutual_friends_count,
        }));
}

export async function suggestionCount(userId: string): Promise<number> {
    const rows = await Relationship.query(
        `SELECT COUNT(*) AS count FROM (
           SELECT r2."to_id"
           FROM relationships r1
           INNER JOIN relationships r2 ON r2."from_id" = r1."to_id" AND r2."type" = $2
           WHERE r1."from_id" = $1 AND r1."type" = $2
           AND r2."to_id" <> $1
           AND NOT EXISTS (SELECT 1 FROM relationships mine WHERE mine."from_id" = $1 AND mine."to_id" = r2."to_id")
           AND NOT EXISTS (SELECT 1 FROM relationships blocked WHERE blocked."from_id" = r2."to_id" AND blocked."to_id" = $1 AND blocked."type" = $3)
           AND NOT EXISTS (SELECT 1 FROM friend_suggestion_dismissals d WHERE d."user_id" = $1 AND d."dismissed_id" = r2."to_id")
           GROUP BY r2."to_id"
         ) candidates`,
        [userId, RelationshipType.FRIEND, RelationshipType.BLOCKED],
    );
    return Number(rows[0]?.count ?? 0);
}
