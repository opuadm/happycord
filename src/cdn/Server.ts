import path from "node:path";
import morgan from "morgan";
import { Server, ServerOptions } from "lambert-server/Server";
import { CORS, BodyParser, Authentication } from "@spacebar/api/middlewares";
import { Attachment, initDatabase } from "@spacebar/database";
import { Config, JwtKeypairManager, registerRoutes, useClientAddress } from "@spacebar/util";
import { ProcessLifecycle, SystemdLifecycle } from "../util/util/ProcessLifecycle";
import { Monitoring } from "../util/monitoring/Monitoring";
import guildProfilesRoute from "./routes/guild-profiles";
import { storageOwnership } from "./util/storageOwnership";
import { cdnResponseSafety, storage } from "./util";
import { readdirSync } from "node:fs";
import { ErrorHandler } from "@spacebar/cdn/util/ErrorHandler";

export type CDNServerOptions = ServerOptions;

export class CDNServer extends Server {
    declare public options: CDNServerOptions;

    constructor(options?: Partial<CDNServerOptions>) {
        super(options);
    }

    async start() {
        await Monitoring.init();
        Monitoring.attach(this.app);
        await initDatabase();
        await Config.init();
        await JwtKeypairManager.init();
        await (storage as typeof storage & { initialize(): Promise<void> }).initialize();

        this.migrateAttachments().then(
            (_) => console.log("[CDN] Successfully migrated attachments"),
            (_) => console.log("[CDN] Attachment migration failed"),
        );

        const logRequests = process.env["LOG_REQUESTS"] != undefined;
        if (logRequests && !this.options.app) {
            this.app.use(
                morgan("combined", {
                    skip: (req, res) => {
                        let skip = !(process.env["LOG_REQUESTS"]?.includes(res.statusCode.toString()) ?? false);
                        if (process.env["LOG_REQUESTS"]?.charAt(0) == "-") skip = !skip;
                        return skip;
                    },
                }),
            );
        }

        useClientAddress(this.app, () => Config.get().security);

        this.app.disable("x-powered-by");

        this.app.use(CORS);
        this.app.use(Authentication);
        this.app.use((req, _res, next) => {
            const actor = req.headers["x-storage-principal"];
            const signature = Config.get().security.requestSignature;
            if (typeof signature === "string" && signature.length && req.headers.signature === signature && typeof actor === "string")
                return storageOwnership.run(actor, () => next());
            return next();
        });
        this.app.use(ErrorHandler);
        this.app.use(BodyParser({ inflate: true, limit: "10mb" }));

        const routesFolder = path.join(__dirname, "routes");
        const publicPrefixes = readdirSync(routesFolder, { withFileTypes: true })
            .map((entry) => entry.name.replace(/\.(js|ts)$/, ""))
            .filter((name) => !name.endsWith(".map") && !name.endsWith(".d") && !name.startsWith("_") && !name.startsWith("federation-") && name !== "ping")
            .sort()
            .map((name) => `/${name}`);
        this.app.use([...new Set(publicPrefixes), "/guilds/:guild_id/users/:user_id/avatars", "/guilds/:guild_id/users/:user_id/banners"], cdnResponseSafety);

        await registerRoutes(this, path.join(__dirname, "routes/"));

        this.app.use("/guilds/:guild_id/users/:user_id/avatars", guildProfilesRoute);
        if (process.env.LOG_ROUTES !== "false") console.log("[Server] Route /guilds/:guild_id/users/:user_id/avatars registered");

        this.app.use("/guilds/:guild_id/users/:user_id/banners", guildProfilesRoute);
        if (process.env.LOG_ROUTES !== "false") console.log("[Server] Route /guilds/:guild_id/users/:user_id/banners registered");

        await super.start();
        await SystemdLifecycle.setStatus(`Listening on ${this.options.host}:${this.options.port}...`);
        await ProcessLifecycle.Ready();
    }

    async migrateAttachments() {
        if (await storage.exists(".mig_complete.attachments1")) return;
        for await (const attachment of await Attachment.createQueryBuilder("attachments").where("message_id is not null").select().stream()) {
            const oldPath = `attachments/${attachment.attachments_channel_id}/${attachment.attachments_id}/${attachment.attachments_filename}`;
            const newPath = `attachments/${attachment.attachments_channel_id}/${attachment.attachments_message_id}/${attachment.attachments_filename}`;
            if (!(await storage.exists(oldPath))) {
                console.log(`[CDN/Attachments] Attachment migration: could not find old path, skipping migration: ` + oldPath);
                continue;
            }
            await storage.move(oldPath, newPath);
        }
        await storage.set(".mig_complete.attachments1", Buffer.from([1]));
    }

    async stop() {
        await ProcessLifecycle.Shutdown();
        await ProcessLifecycle.Finalize();
        return super.stop();
    }
}
