import { NextFunction, Request, Response } from "express";
import { Config } from "@spacebar/util";

export const EMBEDDABLE_CONTENT_SECURITY_POLICY =
    "default-src *  data: blob: filesystem: about: ws: wss: 'unsafe-inline' 'unsafe-eval'; script-src * data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src * data: blob: 'unsafe-inline'; img-src * data: blob: 'unsafe-inline'; frame-src * data: blob: ; style-src * data: blob: 'unsafe-inline'; font-src * data: blob: 'unsafe-inline';";

const originOf = (url: string | null | undefined) => (url && URL.canParse(url) ? new URL(url).origin : undefined);

export function isInstanceOrigin(req: Request, origin: string | undefined) {
    if (!origin) return false;
    const config = (() => {
        try {
            return Config.get();
        } catch {
            return undefined;
        }
    })();
    const own = [`${req.protocol}://${req.get("host")}`, config?.api?.endpointPublic, config?.cdn?.endpointPublic, config?.admin?.endpointPublic].map(originOf);
    return own.includes(originOf(origin) ?? origin);
}

export function CORS(req: Request, res: Response, next: NextFunction) {
    const origin = req.header("Origin");
    const trusted = isInstanceOrigin(req, origin);
    if (trusted) res.set("Access-Control-Allow-Credentials", "true");
    res.set("Access-Control-Allow-Headers", req.header("Access-Control-Request-Headers") || "*");
    res.set("Access-Control-Allow-Methods", req.header("Access-Control-Request-Method") || "*");
    res.set("Access-Control-Allow-Origin", origin ?? "*");
    res.vary("Origin");
    res.set("Access-Control-Max-Age", "60");
    res.set("Content-security-policy", `${EMBEDDABLE_CONTENT_SECURITY_POLICY} frame-ancestors 'self';`);
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "strict-origin-when-cross-origin");
    if (req.secure) res.set("Strict-Transport-Security", "max-age=31536000");

    if (req.method === "OPTIONS") {
        res.status(204).end();
        return;
    }
    next();
}
