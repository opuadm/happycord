import { NextFunction, Request, Response } from "express";
import { Session, User } from "@spacebar/database";
import { Random } from "@spacebar/extensions";
import { checkOAuth2Token, checkToken, getClientPlatform, getClientPlatforms, isOAuth2AccessToken, Rights, UserTokenData } from "@spacebar/util";
import { storageOwnership } from "../../cdn/util/storageOwnership";
import { CORS } from "./CORS";

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
        const options = { ipAddress: req.ip, fingerprint: req.fingerprint };
        const { decoded, user, session, oauth2 } = (req.tokenData = isOAuth2AccessToken(req.headers.authorization)
            ? await checkOAuth2Token(req.headers.authorization, options)
            : await checkToken(req.headers.authorization, options));

        req.token = decoded;
        req.user_id = decoded.id;
        req.user_bot = user.bot;
        req.user = user;
        req.session = session;
        req.oauth2 = oauth2;
        req.rights = new Rights(user.rights);
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
