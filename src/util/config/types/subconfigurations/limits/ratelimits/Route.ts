import { AuthRateLimit } from "./Auth";
import { RateLimitOptions } from "./RateLimitOptions";

export class RouteRateLimit {
    guild: RateLimitOptions = {
        count: 5,
        GET: 50,
        window: 5,
    };
    guildCreate: RateLimitOptions = {
        count: 10,
        window: 60 * 60,
    };
    webhook: RateLimitOptions = {
        count: 10,
        window: 5,
    };
    channel: RateLimitOptions = {
        count: 10,
        GET: 50,
        window: 5,
    };
    user: RateLimitOptions = {
        count: 10,
        window: 10,
    };
    userProfile: RateLimitOptions = {
        count: 5,
        window: 60,
    };
    invite: RateLimitOptions = {
        count: 5,
        window: 10,
    };
    application: RateLimitOptions = {
        count: 10,
        bot: 50,
        window: 10,
    };
    expression: RateLimitOptions = {
        count: 20,
        window: 60,
    };
    interaction: RateLimitOptions = {
        count: 10,
        window: 5,
    };
    oauth2: RateLimitOptions = {
        count: 5,
        window: 10,
    };
    report: RateLimitOptions = {
        count: 5,
        window: 60,
    };
    readState: RateLimitOptions = {
        count: 10,
        window: 10,
    };
    stream: RateLimitOptions = {
        count: 10,
        window: 60,
    };
    connection: RateLimitOptions = {
        count: 5,
        window: 60,
    };
    attachment: RateLimitOptions = {
        count: 20,
        window: 10,
    };
    instanceInvite: RateLimitOptions = {
        count: 10,
        GET: 60,
        window: 60,
    };
    auth: AuthRateLimit = new AuthRateLimit();
}
