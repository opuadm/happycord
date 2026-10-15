process.on("unhandledRejection", console.error);
process.on("uncaughtException", console.error);

import cluster, { Worker } from "node:cluster";
import os from "node:os";
import "reflect-metadata";
import { red, bold, yellow, cyan, blueBright, redBright } from "picocolors";
import { centerString } from "@spacebar/extensions";
import { getRevInfoOrFail, Logo } from "@spacebar/util";
import { initStats } from "./stats";
import { installClusterShutdownSignals } from "./Shutdown";

const cores = process.env.THREADS ? parseInt(process.env.THREADS) : 1;

if (cluster.isPrimary) {
    const revInfo = getRevInfoOrFail();
    Logo.printLogo().then(() => {
        const unformatted = `spacebar-server | !! Pre-release build !!`;
        const formatted = `${blueBright("spacebar-server")} | ${redBright("⚠️ Pre-release build ⚠️")}`;
        console.log(bold(centerString(unformatted, 86).replace(unformatted, formatted)));

        const shortRev = revInfo.rev ? revInfo.rev.slice(0, 7) : "unknown";
        const unformattedRevisionHeader = `Commit Hash: ${revInfo.rev !== null ? `${revInfo.rev} (${shortRev})` : "Unknown"}`;
        const formattedRevisionHeader = `Commit Hash: ${revInfo.rev !== null ? `${cyan(revInfo.rev)} (${yellow(shortRev)})` : "Unknown"}`;
        console.log(bold(centerString(unformattedRevisionHeader, 86).replace(unformattedRevisionHeader, formattedRevisionHeader)));

        const modifiedTime = new Date(revInfo.lastModified * 1000);
        const unformattedLastModified = `Last Updated: ${revInfo.lastModified !== 0 ? `${modifiedTime.toUTCString()}` : "Unknown"}`;
        const formattedLastModified = `Last Updated: ${revInfo.lastModified !== 0 ? `${cyan(modifiedTime.toUTCString())}` : "Unknown"}`;
        console.log(bold(centerString(unformattedLastModified, 86).replace(unformattedLastModified, formattedLastModified)));

        if (revInfo.rev == null) {
            console.log(yellow(`Warning: Git is not installed or not in PATH, or the server is not running from a Git repository.`));
        }

        console.log(`Cores: ${cyan(os.cpus().length)} (Using ${cores} thread(s).)`);
        initStats();

        console.log(`[Process] Starting with ${cores} threads`);

        if (cores === 1) {
            require("./Server");
        } else {
            process.env.EVENT_TRANSMISSION = "process";
            const isStopping = installClusterShutdownSignals();

            // Fork workers.
            for (let i = 0; i < cores; i++) {
                cluster.fork();
                console.log(`[Process] Worker ${cyan(i)} started.`);
            }

            cluster.on("message", (sender: Worker, message) => {
                for (const worker of Object.values(cluster.workers ?? {})) worker?.send(message);
            });

            cluster.on("exit", (worker) => {
                if (isStopping()) return;
                console.log(`[Worker] ${red(`PID ${worker.process.pid} died, restarting ...`)}`);
                cluster.fork();
            });
        }
    });
} else {
    require("./Server");
}
