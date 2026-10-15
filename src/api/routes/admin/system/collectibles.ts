import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { getDatabase } from "@spacebar/database";
import { Collectibles, Config } from "@spacebar/util";

const router = Router({ mergeParams: true });

async function status() {
    const database = getDatabase();
    const [usage] = (await database
        ?.query("SELECT CAST(COALESCE(SUM(bytes),0) AS text) AS bytes,CAST(COUNT(*) AS text) AS objects FROM storage_runtime_objects WHERE category='cache'")
        .catch(() => undefined)) ?? [undefined];
    const [evictions] = (await database
        ?.query(
            "SELECT CAST(COALESCE(SUM(objects),0) AS text) AS objects,CAST(COALESCE(SUM(bytes),0) AS text) AS bytes,CAST(MAX(last_evicted_at) AS text) AS last_evicted_at FROM storage_cache_evictions",
        )
        .catch(() => undefined)) ?? [undefined];
    const { cacheBytes, cacheObjects } = Config.get().cdn.storageQuota;
    return {
        ...(await Collectibles.status()),
        cache: usage && {
            bytes: Number(usage.bytes),
            objects: Number(usage.objects),
            limit_bytes: cacheBytes,
            limit_objects: cacheObjects,
            evicted_objects: Number(evictions?.objects ?? 0),
            evicted_bytes: Number(evictions?.bytes ?? 0),
            last_evicted_at: evictions?.last_evicted_at ? new Date(Number(evictions.last_evicted_at)).toISOString() : null,
        },
    };
}

router.get(
    "/",
    route({
        right: "OPERATOR",
        spacebarOnly: true,
        description: "Where the Shop catalogue comes from, when it was last refreshed and how full the upstream art cache is",
    }),
    async (req: Request, res: Response) => {
        res.json(await status());
    },
);

router.post(
    "/refresh",
    route({
        right: "OPERATOR",
        spacebarOnly: true,
        description: "Download the collectibles catalogue and profile effects again and reload the Shop",
    }),
    async (req: Request, res: Response) => {
        await Collectibles.refresh();
        console.log(`[Admin] User ${req.user_id} refreshed the collectibles catalogue`);
        res.json(await status());
    },
);

export default router;
