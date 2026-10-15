import { Request, Response, Router } from "express";
import { createHash } from "node:crypto";
import { route } from "@spacebar/api/middlewares";
import { Collectibles, CollectibleProduct } from "@spacebar/util";
const router = Router({ mergeParams: true });
let cached: { snapshot: Awaited<ReturnType<typeof Collectibles.get>>; body: string; etag: string } | undefined;
router.get(
    "/",
    route({
        right: "VIEW_USERS",
        spacebarOnly: true,
        description: "Compact local catalog for choosing profile cosmetics in the admin dashboard",
    }),
    async (req: Request, res: Response) => {
        const snapshot = await Collectibles.get();
        if (cached?.snapshot === snapshot) {
            res.set({ "Cache-Control": "private, no-cache", ETag: cached.etag }).type("json").send(cached.body);
            return;
        }
        const items = new Map<string, { sku_id: string; name: string; type: number; asset: string | null; pack: string }>();
        const visit = (product: CollectibleProduct, pack: string) => {
            for (const item of product.items ?? [])
                items.set(item.sku_id, {
                    sku_id: item.sku_id,
                    name: product.name,
                    type: item.type,
                    asset: item.asset ?? null,
                    pack,
                });
            for (const child of [...(product.bundled_products ?? []), ...(product.variants ?? [])]) visit(child, pack);
        };
        const packs = new Map([...(snapshot.builtin ?? snapshot.categories), ...snapshot.categories].map((pack) => [pack.sku_id, pack]));
        for (const pack of packs.values()) for (const product of pack.products) visit(product, pack.name);
        const body = JSON.stringify({ items: [...items.values()] });
        cached = { snapshot, body, etag: `"${createHash("sha256").update(body).digest("base64url")}"` };
        res.set({ "Cache-Control": "private, no-cache", ETag: cached.etag }).type("json").send(cached.body);
    },
);
export default router;
