# Federation registry

The registry is the service we run that tells Meowcord instances which other instances are approved, what is blocked everywhere, and which servers are listed in global discovery. It publishes one JSON document signed with an Ed25519 key, and instances refuse any document that doesn't verify against the key in their config. The contract it implements is [federation-protocol.md](../development/federation-protocol.md), and the plan behind it is [federation.md](../development/federation.md).

It runs at `https://meowcord-registry.tiag.workers.dev` for now. The source is in `extra/registry`: a Cloudflare Worker written in JavaScript with a D1 database.

## Endpoints

| Endpoint | What it does |
| --- | --- |
| `GET /` | The registry's key id, public key and endpoint URLs. |
| `GET /v1/registry` | The signed registry document. Cached for 60 seconds. |
| `POST /v1/announce` | An instance asks to be reviewed or refreshes its data. |
| `/admin` | The review pages, behind hrtID. |

The public key is `f0jm9Szfa52pkT0nWkeZK4D1wa3NUZ9hceWaFQLZYrk` with key id `registry-1`. It is the default `federation.registry.publicKey` in the server config.

### The registry document

The Worker builds the document from D1, signs it and stores the signed copy. It signs a new copy when something in it changes and at least once a day, so `expires_at` is always about 7 days away. `sequence` is the publish time in milliseconds and never goes down. The document lists:

- approved and suspended instances. An approved instance is `active` once it serves a key at `/.well-known/meowcord` with federation turned on, and `listed` until then.
- blocked instances, servers and users, each with a reason and a date.
- discovery servers that an approved instance lists, minus the ones we removed or blocked. The instance's own admins verify a server before the instance lists it, so we review instances, not servers.
- instances that moved to a new id, with the proof the registry checked. See [Moves](#moves).

### Announcing

An instance announces itself on start, once a day and when an admin presses "Send to registry". The registry then:

1. checks that `sent_at` is within 5 minutes and that the nonce wasn't used in the last 10 minutes,
2. fetches `https://<id>/.well-known/meowcord` and checks the announce signature against the key in it,
3. stores the instance as pending review, or updates it if it's already known,
4. stores the admin handles in the announce's `contacts` field, at most 10 and only ones on the announcing instance, in the `instance_contacts` table. They are never published.
5. stores the counts in the announce's `stats` field, if it has one, in the `instance_stats` table. That is one row per instance per hour, and a second announce in the same hour overwrites it. Each count is a whole number from 0 to 1,000,000,000, and a count outside that range is stored as empty. The counts are never published.
6. fetches the instance's signed discovery list and stores its servers, which are published once the instance is approved.

It answers `202` with the instance's status. Announces are limited to 10 per instance id and 30 per IP address per hour, and IPv6 clients share one limit per /64. Announces from instances the registry has never seen share a limit of 60 per hour, checked before the registry fetches anything, so random ids can't fill the database. Pending instances that aren't in `instances.json` and haven't announced for 30 days are deleted with their discovery servers. The admin sign-in page allows 20 attempts per client every 10 minutes.

The registry only fetches public hosts over HTTPS. It refuses `localhost`, IP addresses and private names, resolves the host through DNS over HTTPS and refuses private addresses, doesn't follow redirects, stops after 8 seconds and reads at most 64 KiB of a well-known document and 1 MiB of a discovery list.

### Hourly job

Every hour at minute 17 the Worker:

- imports `instances.json` from the `main` branch on GitHub. Every instance in it counts as approved, unless we blocked or suspended it in the admin pages.
- checks up to 5 moves from `previous_ids` in `instances.json`, see [Moves](#moves).
- re-fetches the well-known document and discovery list of the 8 instances checked longest ago, so each instance is checked every few hours. Instances that moved are skipped.
- deletes old nonces, rate limit counters and sign-in state, activity older than 30 days, and snapshots and instance counts older than 120 days.
- writes one row to `registry_snapshots` for the current hour: approved, pending, suspended and blocked instances, listed discovery servers, blocks, and the network's users, servers and messages in the last day. The network totals add up the latest counts of each approved instance that isn't blocked and reported in the last 72 hours. A second run in the same hour overwrites the row, so the table grows by at most 24 rows a day.
- signs a new document if anything changed or the current one is a day old.

## How we review

The admin pages need an hrtID account in the `admins` group. They have six pages:

- **Overview**: stat cards with sparklines, charts, announce health, what waits for review, errors in the last day, the published document and a button that signs and publishes a new one right away, and the admin group chat.
- **Instances**: approve, suspend or block an instance with a reason, move it back to pending, check it now, or accept a new key. Each instance shows the admin contacts it announced, its latest users, servers and messages in the last day, and a sparkline of its users.
- **Discovery**: remove a server from discovery, list it again, or block it.
- **Blocks**: block or unblock an instance id, or a server or user by canonical id such as `@123@meow.example.com`.
- **Moves**: every move from `previous_ids`, its state, proof and keys, and an Approve button for moves that wait for an admin. Instances that moved are under the Moved filter on the Instances page.
- **Activity**: announces, checks, imports, errors and admin actions.

### Charts

The Overview and Instances pages have a range switch for the last 7, 30 and 90 days. The 7 day range has one point per hour, 30 days one per 6 hours and 90 days one per day, and each point is the last snapshot in its bucket. The last point is always the live count. A bucket without a snapshot leaves a gap in the line.

The Overview has stat cards for approved instances, instances waiting, listed servers, blocks, network users and network servers, each with its change over the range and a sparkline. Below them are line charts of instances by state, listed discovery servers, network users, network servers and network messages in the last day. Announce health lists approved and pending instances with the instance that announced longest ago first, with how long ago it announced and its failed announces and checks from the activity log. Instances announce once a day, so it calls an announce within 26 hours on time, within 72 hours late and older ones silent.

The Worker draws the charts as inline SVG on the server. Each chart has an `aria-label` with its first and last values and a "Show the numbers" table with one row per day. `/admin/charts.js` adds a crosshair and tooltip on hover, on tap and with the arrow keys, and the content security policy allows scripts only from the Worker itself.

`bun scripts/preview-admin.mjs` serves the admin pages on `http://127.0.0.1:8790/admin` with 90 days of sample data in an in-memory SQLite database, to look at them without hrtID. It signs every request in as a preview session it creates in that database. The script only exists in the repository, wrangler doesn't bundle it into the Worker, and it can't reach the production database.

We approve an instance when it has a moderation contact, captcha on registration, and a recent Meowcord version. We don't review servers one by one. A server an approved instance lists goes into the document at the next publish, and stays there through renames. Removing one keeps it out until we list it again, and a block also stops joins and federation for it.

When an approved instance starts serving a different key, the registry keeps publishing the old key and marks the instance "new key waiting". An operator checks with the instance admin that they changed it, then presses "Accept the new key". Until then the registry ignores that instance's discovery list. This stops someone who takes over a domain from speaking for the instance.

## Admin group chat

The Admin group chat card on the Overview page opens a group DM named "Meowcord Admins" between a Meowcord Admins account and the announced admins of every approved instance that isn't blocked. The Worker acts as that account through its instance's API with a user token.

To connect the account, pick its instance on the card, which lists approved instances that aren't blocked, and enter its email or username and password. The Worker signs in with `POST /api/v9/auth/login`. When the account has two-factor authentication on, the next page asks for an authenticator or backup code and sends it to `/api/v9/auth/mfa/totp` or `/api/v9/auth/mfa/backup`. A security key can't finish this sign-in, so give the account a TOTP app or keep a backup code. When the instance answers with a captcha, the card says so, because the Worker can't solve one; `login.requireCaptcha` is off by default. The Worker checks the token with `GET /api/v9/users/@me` and stores only the token, encrypted with AES-GCM under a key derived from `REGISTRY_SIGNING_KEY`, in the `admin_chat_account` table. It never stores the password. Each admin gets 10 sign-in attempts per 15 minutes. Disconnect account signs the token out with `POST /api/v9/auth/logout` and deletes it. To replace a token that leaked, disconnect and connect again, or log the session out from the account's settings on its instance.

The `ADMIN_CHAT_ORIGIN` and `ADMIN_CHAT_TOKEN` secrets still work when no account is connected, and a connected account takes their place. Without either, the open and close buttons are disabled.

Open admin group chat does this:

1. reads `GET /api/v9/users/@me` to learn the account's own id.
2. resolves every handle with `GET /api/v9/federation/users/lookup?handle=<handle>`. A handle that doesn't resolve is listed under Not added with the reason.
3. creates the group DM with `POST /api/v9/users/@me/channels`, the resolved ids as `recipients` and the name "Meowcord Admins". It needs at least two other people.
4. stores the channel id, the handles that joined, the member count and the failures in the `admin_chat` table.

Opening it again while it is open looks up only handles that aren't members yet and adds them with `PUT /api/v9/channels/<id>/recipients/<user_id>`. If the stored channel no longer exists, it creates a new one. Close admin group chat removes every other member with `DELETE /api/v9/channels/<id>/recipients/<user_id>`, then leaves with `DELETE /api/v9/channels/<id>`, which deletes the empty group, and clears the stored state. Every open, update, close and failure is written to the Activity page with the admin who pressed the button.

Each instance sends up to 10 contacts, so the group outgrows the default group DM size of 25 with three instances. A group DM is held to `limits.channel.maxGroupDmRecipients` people, owner included, unless the account that creates it or adds someone has the BYPASS_RATE_LIMITS right, which raises the limit to `limits.channel.maxStaffGroupDmRecipients`, 100 by default. That right also skips the contact spam checks that would stop one account from opening a group with dozens of strangers. Give it to the Meowcord Admins account in the admin dashboard, under Users, and not the OPERATOR right, because the Worker holds that account's token.

Group DMs are end-to-end encrypted from the start. The instance refuses to add a federated user to an encrypted group DM after it was created when that user has no active encryption device, so such an admin shows under Not added until they sign in on a client with encryption set up and the chat is opened again.

## Moves

An instance that changes its address keeps its key and lists its old id in `previous_ids` of its `instances.json` entry. [change-url.md](change-url.md) is the guide for instance admins. On each hourly import the registry takes up to 5 moves that aren't applied yet, oldest checked first, and for each one:

1. refuses it while the old id is still an entry of its own in `instances.json`, when the registry has no record of the old id, when the old id already moved to another id, and when the new id itself moved elsewhere,
2. fetches the new id's well-known document and looks for a move statement in `moved_from` that verifies against the key the registry has for the old id, names both ids and names the key the new id serves. An announce from the new id that verifies against the old key counts too, when the key didn't change,
3. applies the move when it found that proof and the key is the same. A move without proof, or with a new key, waits for an admin on the Moves page. Approve it only after the instance's admins confirmed they run both addresses.

Applying a move runs in one D1 batch. It:

- gives the new id the more restrictive status of the two, so a suspension stays, and the earlier `listed_at`,
- copies an instance block of the old id, and every server and user block under the old id, to the new id. Blocks on the old id stay too,
- moves the discovery servers to the new id and keeps every removal or block we made, then reads the new id's discovery list,
- moves the admin contacts, with their handles renamed to the new id, and the hourly stats,
- marks the old id as `moved`, takes it out of the published instances and records the move in the published `moves` list.

A move back to an earlier id works the same way and retires the earlier move. Moves that drop out of `instances.json` before they are applied are forgotten. The registry never clears a block or a suspension during a move.

## Getting your instance listed

[verification.md](verification.md) has the full guide for instance admins and server owners.

There are two ways, and you can do both:

- **Open a pull request** that adds your instance to `instances.json` and regenerates `instances.md` with `bun scripts/instances-md.mjs`. Once it's merged, the next hourly import lists your instance. See [CONTRIBUTING.MD](../../CONTRIBUTING.MD).
- **Let your instance announce itself.** Federation and announcing are on by default, so a public instance on a real domain announces itself on start. It shows up for review as pending. Nothing is published about it until we approve it.

Your instance only becomes `active`, and so able to federate, when it serves `/.well-known/meowcord` with its key. Until then it is `listed` in the directory.

## Running it

Everything runs from `extra/registry` with Bun and wrangler.

```sh
cd extra/registry
bun install
bun run test
bunx wrangler d1 migrations apply DB --remote
bunx wrangler deploy
```

`bun run test` starts `wrangler dev` with a throwaway signing key and database, serves a fake instance on a local port and announces it, so it needs no Cloudflare account. `bun scripts/verify-registry.mjs` fetches the deployed document and checks its signature against the public key.

| Setting | Kind | What it is |
| --- | --- | --- |
| `REGISTRY_SIGNING_KEY` | secret | The Ed25519 private key as a 32-byte base64url seed. It is in Proton Pass at `projects/meowcord/registry_signing_key`. |
| `OIDC_CLIENT_SECRET` | secret | The hrtID client secret. It only exists in the Worker, rotate it in hrtID to get a new one. |
| `ADMIN_CHAT_ORIGIN` | secret | The https address of the instance that holds the Meowcord Admins account, such as `https://meow.example`. Optional, the admin group chat needs it. |
| `ADMIN_CHAT_TOKEN` | secret | The user token of the Meowcord Admins account on that instance. Optional, the admin group chat needs it. |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `ADMIN_GROUP` | var | hrtID sign-in. Only the `admins` group can use the pages, and hrtID refuses everyone else too. |
| `INSTANCES_JSON_URL` | var | Where the hourly job reads `instances.json`. |
| `REFRESH_BATCH` | var | How many instances the hourly job checks, 8 by default. |
| `ALLOW_PRIVATE_HOSTS` | var | `1` lets the registry fetch `localhost` and private addresses over HTTP. Only for tests and local development. |

Rotating the signing key means shipping a server release with the new public key before the Worker gets the new secret, because instances only trust the key in their config.
