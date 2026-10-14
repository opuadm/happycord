import definePlugin from "@utils/types";
import { FluxDispatcher, RestAPI } from "@webpack/common";

import { FosscordAuthor } from "../fosscordCore/shared";

export function refreshGameRecord(gameId: string) {
    if (!gameId) return;
    void RestAPI.get({ url: "/games", query: { game_ids: [gameId] } })
        .then(({ body }) => {
            if (Array.isArray(body)) FluxDispatcher.dispatch({ type: "GAME_FETCH_SUCCESS", gameIds: [gameId], games: body });
        })
        .catch(() => undefined);
}

export default definePlugin({
    name: "FosscordGameRefresh",
    description: "Refetches a game's record whenever its profile opens, so admin edits show up without reloading.",
    authors: [FosscordAuthor],
    required: true,
    patches: [
        {
            find: "shouldOpenGameProfile&&null!=",
            all: true,
            replacement: {
                match: /(\i\.\i)\.openGameProfileModal\(\{\.\.\.(\i),gameId:(\i),gameProfileModalChecks:(\i)\}\)/,
                replace: "$self.refreshGameRecord($3),$1.openGameProfileModal({...$2,gameId:$3,gameProfileModalChecks:$4})",
            },
        },
    ],
});
