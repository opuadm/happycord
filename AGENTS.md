# Agent guide

Meowcord is a self-hosted server that speaks Discord's REST API, gateway and voice protocol. It serves the official Discord web client from a local cache with Equicord injected, rebranded as the instance. It is a fork of Spacebar server, written in TypeScript on Express 5, TypeORM and PostgreSQL, and it runs on Bun. Some docs and code still say Fosscord, the project's earlier name.

Read [README.md](README.md) for setup, [CONTRIBUTING.MD](CONTRIBUTING.MD) for conventions, [docs/development/client-patches.md](docs/development/client-patches.md) before touching the client and [docs/features/e2ee.md](docs/features/e2ee.md) before touching encryption. [docs/development/parity.md](docs/development/parity.md) lists every Discord feature and its state, and [docs/development/work-backlog.md](docs/development/work-backlog.md) is the task queue. [docs/README.md](docs/README.md) indexes the rest. Update all of these as you go.

## Architecture

| Part             | Where                                                               | Notes                                                                                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REST API         | `src/api`                                                           | Routes under `/api/v9` are files in `src/api/routes`. The path is the file path, `#name` is a parameter and `index.ts` is the directory root. `src/api/routes_toplevel` serves pages outside `/api`.                              |
| Gateway          | `src/gateway`                                                       | The websocket that sends events to clients.                                                                                                                                                                                       |
| CDN              | `src/cdn`                                                           | Attachments, avatars, icons, emojis, stickers.                                                                                                                                                                                    |
| Voice gateway    | `src/webrtc`                                                        | Discord's voice websocket protocol with DAVE. It drives the SFU over a unix socket.                                                                                                                                               |
| SFU              | `extra/pion-sfu`                                                    | Go selective forwarding unit. The server starts it when `PION_SFU_BIN` is set, Docker runs it as its own service. Its IPC protocol is shared with `src/webrtc`.                                                                   |
| Bundle           | `src/bundle`                                                        | Runs API, gateway, CDN and voice in one process on one port. `src/bundle/TestClient.ts` serves the cached client, sets `GLOBAL_ENV`, injects Equicord and the client patch scripts and swaps Discord's images for the instance's. |
| Shared code      | `src/util`, `src/database`, `src/schemas`                           | Config, TypeORM entities and migrations, request and response schemas. `assets/schemas.json` is generated from `src/schemas` and the API validates requests against it.                                                           |
| Equicord layer   | `client/plugins`, `client/equicord-patches`, `client/vencord.json`  | Equicord is built from a pinned commit with our source patches and plugins into `assets/vencord`. Plugins strip upsells and tracking, apply branding and fix what assumes discord.com.                                            |
| Client scripts   | `assets/client_patches`                                             | Plain scripts injected in name order after Equicord. Only code that doesn't touch Discord's webpack modules.                                                                                                                      |
| Static rewrites  | `scripts/client.js`                                                 | String fixes applied once to the downloaded client, for what has to change before any script runs.                                                                                                                                |
| E2EE client      | `client/e2ee`, `client/plugins/fosscordE2ee`                        | The encryption engine, bundled by `scripts/build-e2ee.js` into `assets/public/e2ee` and loaded by `assets/client_patches/10-e2ee-loader.js`. The plugin adds the UI.                                                              |
| Admin dashboard  | `assets/public/admin`, `src/api/routes/admin`                       | Served at `/admin`. Needs the operator right.                                                                                                                                                                                     |
| Status page      | `assets/public/status`, `src/api/routes_toplevel/status.ts`         | Served at `/status`.                                                                                                                                                                                                              |
| Developer portal | `assets/public/developers`, `src/api/routes_toplevel/developers.ts` | OAuth2 apps and bots.                                                                                                                                                                                                             |

The server runs from `dist`, compiled by `tsc` (TypeScript 7 native). `bun run build:src` deletes `dist`, compiles `src`, then copies `scripts/dist-tsconfig.json` to `dist/tsconfig.json` so Bun resolves the `@spacebar/*` and `lambert-server` aliases inside `dist`. Nothing else maps those aliases at runtime. Bun loads `.env` from the working directory by itself.

## Hard rules

- Never commit `assets/cache`, `assets/cache_compressed`, `assets/vencord`, `.vencord` or anything else holding Discord's code or a build of it. They are gitignored, keep it that way.
- Fix things on the server first. Change the client only through the layers above, in this order of preference: a Equicord plugin, a source patch in `client/equicord-patches`, a script in `assets/client_patches`, a rewrite in `scripts/client.js`. Follow the patch rules in `docs/development/client-patches.md`.
- Branding goes through `client.instanceName`, `client.icon` and `client.logo`. Never hard-code a product name in user-facing strings.
- Owner policy: no Quests, Orbs, ads, sponsored content, download-the-app prompts or upsells. Every account has Premium and every server is boost level 3 with 33 boosts. Nothing can be bought and every Shop item is free. Don't add code paths that gate features on payment.
- Never clear rate limits, rows or accounts on a database you didn't create for the test run.
- Pride flags are permanent. Never add a config key, environment variable, admin toggle, experiment or plugin setting that hides or disables pride badges, the pride picker, or flag picking at signup, and never make the `fosscordPride` plugin optional. Never add heterosexual or cisgender flags. `scripts/tests/pride-permanent.test.cjs` enforces this; don't weaken it.

## Workflow

Bun 1.4 runs everything: installs, the server, scripts and tests. Don't use npm, npx or node.

```sh
bun install
bun run generate:client
scripts/dev/worktree-setup.sh 3001 meowcord
```

`worktree-setup.sh <port> <db>` runs `bun install`, writes `.env` and `config.json`, builds the SFU when Go is installed, creates a fresh database and refuses existing databases, runtime configuration and occupied ports, builds, starts the server and seeds two accounts. In a git worktree it links `assets/cache`, `assets/cache_compressed` and `assets/vencord` from the main checkout. Give each worktree its own port and database.

| Command                                                                | Use                                                                                                                             |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `bun run build:src`                                                    | Compile `src` into a fresh `dist` and draw the default avatars.                                                                 |
| `PORT=3001 SERVER_LOG=$PWD/server.log scripts/dev/restart.sh`          | Restart the dev server on the current build.                                                                                    |
| `PORT=3001 bun scripts/dev/seed.mjs`                                   | Register the test accounts, a DM and a server. Passwords go to `scripts/dev/.test-account`.                                     |
| `PORT=3001 bun scripts/dev/probe.mjs <path>`                           | Open a client page as the test user and print its text, console errors and failed requests. `--shot <file>` saves a screenshot. |
| `PORT=3001 bun scripts/dev/parity-probe.mjs`                           | API parity checks, about 150. Ends with the pass and fail count.                                                                |
| `PORT=3001 E2EE_TEST_DATABASE_NAME=<db> bun scripts/dev/e2ee-test.mjs` | Browser test of encrypted DMs, backup, recovery and device approval. Several minutes.                                           |
| `PORT=3001 bun scripts/dev/voice-probe.mjs --browser <path>`           | Two browsers in a voice channel, prints audio sent and received on each side. Needs the SFU.                                    |
| `PORT=3001 bun run check:client`                                       | Build Equicord's reporter and check every patch still matches the cached client. Clones Equicord into `.vencord`, about 300 MB. |
| `PORT=3001 bun scripts/dev/message-queries.mjs`                        | Count and time the SQL queries behind message endpoints from `server.log`.                                                      |
| `bun run build:e2ee`                                                   | Typecheck and rebundle `client/e2ee` into `assets/public/e2ee`. Commit the output with the source.                              |
| `bun run build:equicord`                                               | Rebuild `assets/vencord` after changing `client/plugins` or `client/equicord-patches`.                                          |
| `bun run generate:schema`, `bun run generate:openapi`                  | Regenerate `assets/schemas.json` and `assets/openapi.json` from a fresh build.                                                  |
| `bun run lint`, `bun run format`                                       | Biome.                                                                                                                          |
| `bun run test`                                                         | Unit tests in `scripts/tests`, `scripts/dev` and `dist`, using `node:test` under `bun test`. Build first.                       |

The browser scripts use `playwright-core` from `~/.cache/fosscord-tools`. Install it with `mkdir -p ~/.cache/fosscord-tools && bun add --cwd ~/.cache/fosscord-tools playwright-core`.

## Before pushing

- `bun run build:src` and `bun run lint` pass.
- `bun run test` shows no failures beyond the ones already on `main`, listed in CONTRIBUTING.MD.
- Restart the server and run the parity probe on a freshly seeded database. Clear `rate_limits` on that database first, see the gotchas.
- Run `e2ee-test.mjs` after changing messages, channels, sessions, the gateway, `client/e2ee`, `client/plugins/fosscordE2ee` or the `e2ee` routes.
- Run `voice-probe.mjs` after changing `src/webrtc` or `extra/pion-sfu`.
- Run `check:client` after changing `client/plugins`, `client/equicord-patches` or `client/vencord.json`, and after downloading a new Discord build.
- Update the row in `docs/development/parity.md` when a feature's state changes.

## Migrations

- They live in `src/database/migration/postgres` and `src/database/migration/sqlite` and run on startup in timestamp order. A schema change needs an equivalent migration for both backends, and the SQLite baseline stays unchanged. See [docs/self-hosting/databases.md](docs/self-hosting/databases.md).
- Each one is idempotent: `IF NOT EXISTS`, `IF EXISTS`, or a check before the change. A migration can run against a database that already has its change.
- The timestamp is later than every existing migration and unique, with a random suffix such as `1791514025449`.
- Never touch a table that a migration with a later timestamp creates, because a fresh database hasn't created it yet.
- Test a new migration on a fresh database with `worktree-setup.sh`, which creates it only when it does not already exist.

## Code style

- No code comments. Name things so the code reads without them.
- Biome lints and formats with `biome.json`: 4-space indents, double quotes, trailing commas, 180 character lines. The pre-commit hook in `.githooks` runs `biome check` on staged files and the build. `bun install` turns it on.
- Every new source file starts with the AGPL header. Copy it from any file in `src`.
- Keep value imports for types that decorated TypeORM properties use. `emitDecoratorMetadata` needs them, so don't convert them to `import type`.
- Commit subjects are lowercase conventional commits in the imperative, with an optional scope, no trailing period and no body: `fix(e2ee): keep the nonce on nonce-bound encrypted messages`. Types in use are `feat`, `fix`, `perf`, `docs`, `test`, `chore`, `build`, `refactor` and `style`.
- Docs are plain sentences that say what happens, with numbers where there are numbers. No em dashes or en dashes.

## Gotchas

- Rate limits persist in the `rate_limits` table and survive restarts. Clear them on your own test database between probe runs with `psql <db> -c "delete from rate_limits"`, or later runs fail with 429.
- Registration needs a Cap captcha by default. The seed script and the probes solve it in a headless browser through `scripts/dev/cap-token.mjs`.
- Headless Google Chrome quits after about 30 seconds on the owner's Mac. Use Brave: `CHROME_PATH="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"`, and pass the same path to `voice-probe.mjs --browser`.
- `bun run build:src` deletes `dist` first, so a stale compiled route from a deleted source file can't shadow a current one. A server started from the checkout keeps running the old code until you restart it.
- Don't commit a regenerated `assets/openapi.json` from a worktree branch. Parallel branches all conflict on it, so regenerate it on `main` after merging.
- Bun returns `readdir` entries unsorted, unlike Node. Sort any directory listing whose order matters, as `lambert-server` does for route registration and `scripts/util/walk.js` does for schema generation.
- A fresh worktree config has `externalRequests` off, so link unfurls, the detectable games list and Krisp models fail in the parity probe until you turn on `thirdParty`, `discordGames` and `discordAssetFallback` and link `assets/detectable.json` from the main checkout.
- Worktrees under `.claude/worktrees` have a dot directory in their path. Express's `sendFile` refuses those paths unless it gets `dotfiles: "allow"`.
- The disk is often nearly full. When you're done, stop the server, drop the database, remove the worktree, any `.vencord` clone and screenshots.
- The Equicord build runs Equicord's own pnpm toolchain inside `.vencord/src`, and that toolchain runs Node.js. It is the one place Node is still needed.
