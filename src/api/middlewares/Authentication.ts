import { NextFunction, Request, Response } from "express";
import { Session, User } from "@spacebar/database";
import { Random } from "@spacebar/extensions";
import {
    checkOAuth2Token,
    checkToken,
    federationRelaySecret,
    getClientPlatform,
    getClientPlatforms,
    isOAuth2AccessToken,
    relayApiPath,
    relayLoopbackAllowed,
    effectiveRights,
    Rights,
    UserTokenData,
} from "@spacebar/util";
import { storageOwnership } from "../../cdn/util/storageOwnership";
import { CORS, isInstanceOrigin } from "./CORS";

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            user_id: string;
            user_bot: boolean;
            tokenData: UserTokenData;
            token: { id: string; iat: number; ver?: number; did?: string };
            user: User;
            session?: Session;
            rights: Rights;
            fingerprint?: string;
            isAuthenticated: boolean;
            oauth2?: UserTokenData["oauth2"];
            federationRelay?: boolean;
        }
    }
}

export async function Authentication(req: Request, res: Response, next: NextFunction) {
    if (req.method === "OPTIONS") return CORS(req, res, next);
    if (req.isAuthenticated !== undefined) return next();

    if (req.headers.cookie?.split("; ").find((x) => x.startsWith("__sb_sessid=")))
        req.fingerprint = req.headers.cookie
            .split("; ")
            .find((x) => x.startsWith("__sb_sessid="))!
            .split("=")[1];
    else
        res.setHeader(
            "Set-Cookie",
            `__sb_sessid=${(req.fingerprint = Random.getString("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", 32))}; Secure; HttpOnly; SameSite=None; Path=/`,
        );

    await handleAuthentication(req);

    return req.isAuthenticated && req.user_id ? storageOwnership.run(`user:${req.user_id}`, () => next()) : next();
}

export async function handleAuthentication(req: Request) {
    if (!req.headers.authorization || /^Basic\s/i.test(req.headers.authorization)) {
        req.isAuthenticated = false;
        return;
    }

    try {
        const relayHeader = req.headers["x-meowcord-relay"];
        req.federationRelay =
            typeof relayHeader === "string" && relayHeader === federationRelaySecret() && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");
        const foreignOrigin = !!req.headers.origin && !isInstanceOrigin(req, req.headers.origin);
        const sentFingerprint = !!req.fingerprint && !!req.headers.cookie?.split("; ").includes(`__sb_sessid=${req.fingerprint}`);
        const options = {
            ipAddress: req.ip,
            fingerprint: foreignOrigin || !sentFingerprint ? undefined : req.fingerprint,
            federationRelay: req.federationRelay,
            propagateBans: !foreignOrigin,
        };
        const { decoded, user, session, oauth2 } = (req.tokenData = isOAuth2AccessToken(req.headers.authorization)
            ? await checkOAuth2Token(req.headers.authorization, options)
            : await checkToken(req.headers.authorization, options));
        if (user.federated_instance) {
            const path = relayApiPath(req.originalUrl.split("?")[0]);
            if (!req.federationRelay || !path || !relayLoopbackAllowed(req.method, path)) throw new Error("A shadow user's relay token can't reach this route");
        }

        req.token = decoded;
        req.user_id = decoded.id;
        req.user_bot = user.bot;
        req.user = user;
        req.session = session;
        req.oauth2 = oauth2;
        req.rights = await effectiveRights(user.id, user.rights);
        req.isAuthenticated = true;

        const superProperties = req.headers["x-super-properties"];
        if (session && !session.client_info?.os && typeof superProperties === "string") {
            const properties = (() => {
                try {
                    return JSON.parse(Buffer.from(superProperties, "base64").toString("utf8"));
                } catch {
                    return null;
                }
            })();
            if (typeof properties?.os === "string" && properties.os) {
                const browser = typeof properties.browser === "string" ? properties.browser : undefined;
                session.client_info = {
                    ...session.client_info,
                    os: properties.os,
                    browser,
                    platform: getClientPlatform({ os: properties.os, browser }),
                };
                session.client_status =
                    session.status === "invisible" ? {} : Object.fromEntries(getClientPlatforms({ os: properties.os, browser }).map((platform) => [platform, session.status]));
                await Session.update({ session_id: session.session_id }, { client_info: session.client_info, client_status: session.client_status });
            }
        }
    } catch (e) {
        req.isAuthenticated = false;
        console.error("[Authentication] Token was provided, but was invalid:", e);
    }
}
