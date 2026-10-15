import { sqlLike } from "@spacebar/database/Sql";
import { Request, Response, Router } from "express";
import { Brackets } from "typeorm";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { User } from "@spacebar/database";
import { AdminUserTag, UserFlags } from "@spacebar/schemas";
import { ipVariants, isProtectedStaffTarget, parseIp } from "@spacebar/api/util";
import { originClause, parseOrigin } from "@spacebar/api/util/utility/federatedAdmin";

const router = Router({ mergeParams: true });

export const ADMIN_USER_COLUMNS = [
    "id",
    "username",
    "discriminator",
    "global_name",
    "avatar",
    "email",
    "created_at",
    "disabled",
    "deleted",
    "verified",
    "premium_type",
    "rights",
    "bot",
    "flags",
    "public_flags",
    "badge_ids",
    "hide_premium_badge",
    "account_standing",
    "suspended_until",
    "join_status",
    "join_reason",
    "federated_instance",
] as const;

// entities carry class-level defaults for every column, so only ever send the columns we selected
export const pickAdminUser = (user: User) => ({
    ...Object.fromEntries(ADMIN_USER_COLUMNS.map((c) => [c, user[c] ?? null])),
    tag: userTag(user),
});

export const assertCanManage = (req: Request, target: Pick<User, "id" | "rights">) => {
    if (isProtectedStaffTarget({ id: req.user_id, rights: req.rights.bitfield }, target)) throw new HTTPError("Only operators can manage other staff accounts", 403);
};

const TAG_FLAGS = {
    verified: Number(UserFlags.FLAGS.VERIFIED_BOT),
    ai: Number(UserFlags.FLAGS.AI_ACCOUNT),
    official: Number(UserFlags.FLAGS.OFFICIAL_TAG),
    system: Number(UserFlags.FLAGS.SYSTEM_TAG),
};

export const userTag = (user: Pick<User, "public_flags">): AdminUserTag => {
    const flags = Number(user.public_flags ?? 0);
    if (flags & TAG_FLAGS.official) return "official";
    if (flags & TAG_FLAGS.system) return "system";
    const verified = (flags & TAG_FLAGS.verified) !== 0;
    if (flags & TAG_FLAGS.ai) return verified ? "verified_ai" : "ai";
    return verified ? "verified_bot" : "none";
};

// public_flags is what other clients see; flags is what the user's own client sees, so both carry the tag
export const applyUserTag = (user: User, tag: AdminUserTag) => {
    const wanted =
        (tag === "verified_bot" || tag === "verified_ai" ? TAG_FLAGS.verified : 0) |
        (tag === "ai" || tag === "verified_ai" ? TAG_FLAGS.ai : 0) |
        (tag === "official" ? TAG_FLAGS.official : 0) |
        (tag === "system" ? TAG_FLAGS.system : 0);
    const mask = TAG_FLAGS.verified | TAG_FLAGS.ai | TAG_FLAGS.official | TAG_FLAGS.system;
    user.public_flags = (Number(user.public_flags ?? 0) & ~mask) | wanted;
    user.flags = Number((BigInt(user.flags ?? 0) & ~BigInt(mask)) | BigInt(wanted));
};

export const scalarQuery = (value: unknown, name: string, fallback: string): string => {
    if (value === undefined) return fallback;
    if (typeof value !== "string") throw new HTTPError(`${name} must be supplied once as a string`, 400);
    return value;
};

export const paginationQuery = (value: unknown, name: string, fallback: number): number => {
    const text = scalarQuery(value, name, String(fallback));
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) throw new HTTPError(`${name} must be a non-negative safe integer`, 400);
    return Number(text);
};

const USER_FILTERS = ["all", "disabled", "suspended", "pending", "with_reason", "bots", "verified", "unverified"] as const;
const USER_SORTS: Record<string, [string, "ASC" | "DESC"][]> = {
    newest: [
        ["user.created_at", "DESC"],
        ["user.id", "DESC"],
    ],
    oldest: [
        ["user.created_at", "ASC"],
        ["user.id", "ASC"],
    ],
    name: [
        ["user.username", "ASC"],
        ["user.id", "ASC"],
    ],
};

export const parseUserHandle = (q: string) => {
    const handle = /^@?(.+?)#(\d{1,4})$/.exec(q);
    if (handle) return { text: handle[1], discriminator: handle[2] };
    return { text: q.startsWith("@") && q.length > 1 ? q.slice(1) : q, discriminator: undefined };
};

export const userSearchQuery = (req: Request) => {
    const q = scalarQuery(req.query.q, "q", "").trim();
    if (q.length > 256) throw new HTTPError("q must be no longer than 256 characters", 400);
    const filter = scalarQuery(req.query.filter, "filter", "all");
    if (!(USER_FILTERS as readonly string[]).includes(filter))
        throw new HTTPError("filter must be all, disabled, suspended, pending, with_reason, bots, verified or unverified", 400);
    const ipText = scalarQuery(req.query.ip, "ip", "").trim();
    const ip = ipText ? parseIp(ipText) : parseIp(q);
    if (ipText && !ip) throw new HTTPError("ip must be an IPv4 or IPv6 address", 400);
    const sort = scalarQuery(req.query.sort, "sort", "newest");
    if (!Object.hasOwn(USER_SORTS, sort)) throw new HTTPError("sort must be newest, oldest or name", 400);
    const origin = parseOrigin(req.query.origin);
    const exactId = !ip && /^\d{15,20}$/.test(q);
    const handle = parseUserHandle(q);
    const searchPattern = `%${handle.text.replace(/[\\%_]/g, "\\$&")}%`;

    const [[firstColumn, firstOrder], ...tieBreaks] = USER_SORTS[sort];
    const query = User.createQueryBuilder("user").orderBy(firstColumn, firstOrder);
    for (const [column, order] of tieBreaks) query.addOrderBy(column, order);

    if (ip) {
        const ips = ipVariants(ip);
        query.where(
            new Brackets((qb) =>
                qb.where("user.registration_ip IN (:...ips)", { ips }).orWhere("user.id IN (SELECT s.user_id FROM sessions s WHERE s.last_seen_ip IN (:...ips))", { ips }),
            ),
        );
        if (ipText && q)
            query.andWhere(
                new Brackets((qb) => qb.where(`${sqlLike("user.username", ":q")}`, { q: searchPattern }).orWhere(`${sqlLike("user.global_name", ":q")}`, { q: searchPattern })),
            );
    } else if (exactId) {
        if (BigInt(q) > 9223372036854775807n) throw new HTTPError("The user id is outside the supported range", 400);
        query.where("user.id = :id", { id: q });
    } else if (handle.discriminator) {
        query.where(`${sqlLike("user.username", ":q")}`, { q: searchPattern });
        query.andWhere("user.discriminator = :discriminator", { discriminator: handle.discriminator });
    } else if (q)
        query.where(
            new Brackets((qb) =>
                qb
                    .where(`${sqlLike("user.username", ":q")}`, { q: searchPattern })
                    .orWhere(`${sqlLike("user.global_name", ":q")}`, { q: searchPattern })
                    .orWhere(`${sqlLike("user.email", ":q")}`, { q: searchPattern }),
            ),
        );

    switch (filter) {
        case "disabled":
            query.andWhere("user.disabled = true");
            break;
        case "suspended":
            query.andWhere("user.suspended_until > :now", { now: new Date() });
            break;
        case "pending":
            query.andWhere("user.join_status = 'pending'");
            break;
        case "with_reason":
            query.andWhere("user.join_reason IS NOT NULL");
            break;
        case "bots":
            query.andWhere("user.bot = true");
            break;
        case "verified":
            query.andWhere("user.verified = true");
            break;
        case "unverified":
            query.andWhere("user.verified = false");
            break;
        default:
            break;
    }
    const clause = exactId ? null : originClause("user", origin);
    if (clause) query.andWhere(clause);
    return query;
};

router.get(
    "/",
    route({
        right: "VIEW_USERS",
        spacebarOnly: true,
        description:
            "Search users on this instance. `q` matches an exact id, an IP address, a handle such as `@name` or `name#1234`, or part of a username, display name or email. `ip` lists the accounts that registered on or signed in from an address.",
        query: {
            q: { type: "string", required: false },
            ip: { type: "string", required: false, description: "An IPv4 or IPv6 address" },
            filter: {
                type: "string",
                required: false,
                description: "all | disabled | suspended | pending | with_reason | bots | verified | unverified",
            },
            origin: {
                type: "string",
                required: false,
                description: "local (default) lists accounts of this instance, remote lists users of other instances stored here, all lists both. An exact id search ignores it",
            },
            sort: { type: "string", required: false, description: "newest (default), oldest or name" },
            limit: { type: "number", required: false },
            offset: { type: "number", required: false },
        },
    }),
    async (req: Request, res: Response) => {
        const limit = Math.min(Math.max(paginationQuery(req.query.limit, "limit", 50), 1), 100);
        const offset = paginationQuery(req.query.offset, "offset", 0);
        const [users, total] = await userSearchQuery(req)
            .select(ADMIN_USER_COLUMNS.map((c) => `user.${c}`))
            .take(limit)
            .skip(offset)
            .getManyAndCount();
        res.json({ total, users: users.map(pickAdminUser) });
    },
);

export default router;
