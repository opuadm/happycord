import http from "node:http";
import type { Duplex } from "node:stream";
import path from "node:path";
import morgan from "morgan";
import { red } from "picocolors";
import ws from "ws";
import { Server, ServerOptions } from "lambert-server";
import { initDatabase } from "@spacebar/database";
import { Config, initEvent, JSONReplacer, JwtKeypairManager, registerRoutes, useClientAddress } from "@spacebar/util";
import { ProcessLifecycle, SystemdLifecycle } from "../util/util/ProcessLifecycle";
import { Monitoring } from "../util/monitoring/Monitoring";
import { Connection } from "./events/Connection";
import { RemoteAuthConnection } from "./events/RemoteAuth";
import { cleanupOnStartup, startPresenceSweep, stopPresenceSweep } from "./util";
import { Authentication, BodyParser, CORS, ErrorHandler } from "@spacebar/api";
import { DetectableGames } from "@spacebar/api/util/utility/games";

export class GatewayServer extends Server {
    public ws: ws.Server;
    public remoteAuth: ws.Server;
    // websocket paths served by something else sharing this http server (e.g. the voice gateway in the bundle)
    public upgradeRoutes = new Map<string, (request: http.IncomingMessage, socket: Duplex, head: Buffer) => void>();

    constructor(options?: Partial<ServerOptions>) {
        super(options);

        this.http ??= http.createServer(this.app);

        this.http.on("upgrade", (request, socket, head) => {
            for (const [prefix, handle] of this.upgradeRoutes)
                if (request.url === prefix || request.url?.startsWith(`${prefix}/`) || request.url?.startsWith(`${prefix}?`)) return handle(request, socket, head);
            if (request.url?.startsWith("/remote-auth"))
                return this.remoteAuth.handleUpgrade(request, socket, head, (socket) => {
                    RemoteAuthConnection(socket, request);
                });
            this.ws.handleUpgrade(request, socket, head, (socket) => {
                this.ws.emit("connection", socket, request);
            });
        });

        this.remoteAuth = new ws.Server({ maxPayload: 4096, noServer: true });

        this.ws = new ws.Server({
            maxPayload: 16384,
            noServer: true,
        });
        this.ws.on("connection", Connection);
        this.ws.on("error", console.error);
    }

    async start(): Promise<void> {
        const logRequests = process.env["LOG_REQUESTS"] != undefined;

        await Monitoring.init();
        Monitoring.attach(this.app);
        await initDatabase();
        await Config.init();
        await DetectableGames.load();
        await initEvent();
        // temporary fix
        await cleanupOnStartup();
        startPresenceSweep();
        await JwtKeypairManager.init();

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

        this.app.set("json replacer", JSONReplacer);
        this.app.disable("x-powered-by");

        useClientAddress(this.app, () => Config.get().security);

        this.app.use(CORS);
        this.app.use(BodyParser({ inflate: true, limit: "10mb" }));
        this.app.use(Authentication);

        this.routes = (await registerRoutes(this, path.join(__dirname, "routes", "/"))).filter((r) => !!r);

        this.app.get("/", (req, res) => res.status(200).send("Online"));

        this.app.use(ErrorHandler);
        if (logRequests) console.log(red(`Warning: Request logging is enabled! This will spam your console!\nTo disable this, unset the 'LOG_REQUESTS' environment variable!`));

        await super.start();
        await SystemdLifecycle.setStatus(`Listening on ${this.options.host}:${this.options.port}...`);

        await ProcessLifecycle.Ready();
    }

    async stop() {
        const presence = stopPresenceSweep();
        await ProcessLifecycle.Shutdown();
        await presence;
        this.ws.clients.forEach((x) => x.close());
        this.ws.close();
        this.http.close();
        await ProcessLifecycle.Finalize();
    }
}
