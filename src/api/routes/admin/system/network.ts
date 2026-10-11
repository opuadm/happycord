/* SPDX-License-Identifier: AGPL-3.0-only */
import { connect } from "node:net";
import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { Config } from "@spacebar/util";
import { outboundProxyStatus } from "@spacebar/util/util/networking/SocksTransport";

const router = Router({ mergeParams: true });

router.get("/", route({ right: "OPERATOR", spacebarOnly: true, description: "Outbound proxy and link preview health" }), async (req: Request, res: Response) => {
    const status = outboundProxyStatus();
    const { proxy } = status;
    const reachable = proxy
        ? await new Promise<boolean>((resolve) => {
              const socket = connect({ host: proxy.host, port: proxy.port, timeout: 2000 });
              const finish = (result: boolean) => {
                  socket.destroy();
                  resolve(result);
              };
              socket.once("connect", () => finish(true));
              socket.once("timeout", () => finish(false));
              socket.once("error", () => finish(false));
          })
        : null;
    res.json({
        mode: status.mode,
        proxy: proxy ? `${proxy.host}:${proxy.port}` : null,
        reachable,
        problem: status.problem ?? (reachable === false ? `The SOCKS5 proxy at ${proxy?.host}:${proxy?.port} refused the connection or didn't answer within 2 seconds` : null),
        third_party: Config.get().externalRequests.thirdParty,
    });
});

export default router;
