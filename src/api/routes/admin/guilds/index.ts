import { sqlLike } from "@spacebar/database/Sql";
import { Request, Response, Router } from "express";
import { In } from "typeorm";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { Guild, Member, User } from "@spacebar/database";
import { originClause, parseOrigin } from "@spacebar/api/util/utility/federatedAdmin";

const router = Router({ mergeParams: true });

export const pickOwner = (user: User | null | undefined, id: string) =>
    user
        ? {
              id: user.id,
              username: user.username,
              discriminator: user.discriminator,
              global_name: user.global_name ?? null,
              avatar: user.avatar ?? null,
          }
        : { id };

const scalarQuery = (value: unknown, name: string, fallback: string): string => {
    if (value === undefined) return fallback;
    if (typeof value !== "string") throw new HTTPError(`${name} must be supplied once as a string`, 400);
    return value;
};

const paginationQuery = (value: unknown, name: string, fallback: number): number => {
    const text = scalarQuery(value, name, String(fallback));
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) throw new HTTPError(`${name} must be a non-negative safe integer`, 400);
    return Number(text);
};

const GUILD_SORTS: Record<string, [string, "ASC" | "DESC"][]> = {
    newest: [["guild.id", "DESC"]],
    oldest: [["guild.id", "ASC"]],
    name: [
        ["guild.name", "ASC"],
        ["guild.id", "ASC"],
    ],
    members: [
        ["member_count", "DESC"],
        ["guild.id", "DESC"],
    ],
};

router.get(
    "/",
    route({
        right: "MANAGE_GUILDS",
        spacebarOnly: true,
        description: "Search servers on this instance. `q` matches an exact id or part of the name.",
        query: {
            q: { type: "string", required: false },
            origin: {
                type: "string",
                required: false,
                description: "local (default) lists servers hosted here, remote lists mirrors of servers on other instances, all lists both. An exact id search ignores it",
            },
            sort: { type: "string", required: false, description: "newest (default), oldest, name or members" },
            limit: { type: "number", required: false },
            offset: { type: "number", required: false },
        },
    }),
    async (req: Request, res: Response) => {
        const q = scalarQuery(req.query.q, "q", "").trim();
        if (q.length > 256) throw new HTTPError("q must be no longer than 256 characters", 400);
        const sort = scalarQuery(req.query.sort, "sort", "newest");
        if (!Object.hasOwn(GUILD_SORTS, sort)) throw new HTTPError("sort must be newest, oldest, name or members", 400);
        const limit = Math.min(Math.max(paginationQuery(req.query.limit, "limit", 50), 1), 100);
        const offset = paginationQuery(req.query.offset, "offset", 0);
        const origin = parseOrigin(req.query.origin);
        if (/^\d{15,20}$/.test(q) && BigInt(q) > 9223372036854775807n) throw new HTTPError("The server id is outside the supported range", 400);

        const query = Guild.createQueryBuilder("guild")
            .select(["guild.id", "guild.name", "guild.icon", "guild.owner_id", "guild.features", "guild.description", "guild.profile", "guild.federated_instance"])
            .addSelect((sub) => sub.select("COUNT(*)", "count").from(Member, "member").where("member.guild_id = guild.id"), "member_count")
            .limit(limit)
            .offset(offset);
        const [[firstColumn, firstOrder], ...tieBreaks] = GUILD_SORTS[sort];
        query.orderBy(firstColumn, firstOrder);
        for (const [column, order] of tieBreaks) query.addOrderBy(column, order);

        const exactId = /^\d{15,20}$/.test(q);
        if (exactId) query.where("guild.id = :id", { id: q });
        else if (q) query.where(`${sqlLike("guild.name", ":q")}`, { q: `%${q.replace(/[\\%_]/g, "\\$&")}%` });
        const clause = exactId ? null : originClause("guild", origin);
        if (clause) query.andWhere(clause);

        const [{ entities, raw }, total] = await Promise.all([query.getRawAndEntities(), query.getCount()]);

        const ownerIds = [...new Set(entities.map((g) => g.owner_id).filter((id): id is string => !!id))];
        const owners = ownerIds.length
            ? await User.find({
                  where: { id: In(ownerIds) },
                  select: { id: true, username: true, discriminator: true, global_name: true },
              })
            : [];

        res.json({
            total,
            guilds: entities.map((g, i) => ({
                id: g.id,
                name: g.name,
                icon: g.icon ?? null,
                description: g.description ?? null,
                features: g.features,
                member_count: Number(raw[i]?.member_count ?? 0),
                federated_instance: g.federated_instance ?? null,
                tag: g.profile?.tag ? { tag: g.profile.tag, badge_hash: g.profile.badge_hash ?? null } : null,
                owner: g.owner_id
                    ? pickOwner(
                          owners.find((o) => o.id === g.owner_id),
                          g.owner_id,
                      )
                    : null,
            })),
        });
    },
);

export default router;
