# Security review

This page records the adversarial review of October 2026, what it found, what changed, and how to run the checks again. Federation and automod were reviewed separately and are not covered here.

## What was reviewed

- Authorization on every REST route. `scripts/dev/route-audit.mjs` walks `src/api/routes` and `src/api/routes_toplevel` and prints each handler with its authentication mode, permission, right and OAuth2 scope. It found 758 handlers in 498 files. `--flagged` lists the handlers with no `route()` middleware, unauthenticated writes, admin routes without a right and OAuth2-reachable routes without a scope check, which were read by hand. Suspicious routes were then tried live with two accounts.
- Sign-in and sessions: tokens, two factor, password reset, email verification, lockout, passkeys and OAuth2.
- The gateway: opcodes before Identify, compression, member and presence requests, voice channel statuses.
- The CDN: content types, path handling and response headers.
- Web pages: framing, content sniffing, redirect URIs and HTML built from user input.
- Rate limits: bucket keys, forwarded addresses and IPv6.
- Secrets in responses and logs.

## Findings

Severity is what an attacker gets on a default instance. Each fix has a unit test in `scripts/tests/security-*.test.cjs`, and the ones marked "probe" are also attacked end to end by `scripts/dev/security-probe.mjs`.

| Severity | Finding | Fix |
| --- | --- | --- |
| High | An SVG, HTML or XML attachment was served with its own content type from the same origin as the client, so opening its link ran script with access to the user's token. Probe. | Every CDN response gets `nosniff` and a `sandbox` content security policy, and only image, audio, video, JSON, PDF, font and plain text types are served inline. Everything else is a download. |
| High | An OAuth2 application could register a `javascript:` or `data:` redirect URI, which ran script on the instance origin after authorization. Probe. | Redirect URIs must parse as URLs and can't use `javascript`, `data`, `vbscript`, `file`, `blob`, `about` or `filesystem`, both when saved and when authorizing. |
| High | An email verification link issued a fresh session token every time it was opened, including for accounts with two factor. Anyone who later read the email could sign in. | The link signs in only on the first use and never for an account with two factor. |
| High | A user with `MANAGE_USERS` could edit, disable or remove other staff accounts, operators included. | Staff can only act on accounts below their highest staff role, operators are above every role, and accounts with staff rights but no role can only be managed by operators. See [admin.md](../features/admin.md#staff-roles). |
| High | The staff check counted `VIEW_SERVER_STATS` and `RESEND_VERIFICATION_EMAIL` as staff rights, but both are in the default rights, so every regular account was protected staff and `MANAGE_USERS` moderators couldn't act on anyone. | Those two rights no longer mark an account as staff. A unit test checks that the default rights are not staff. |
| Medium | Every admin route needed `MANAGE_USERS` or `OPERATOR`, so giving someone read access to reports also let them edit profiles, delete accounts and change automod settings. | Admin routes need narrower rights (`VIEW_USERS`, `VIEW_MODERATION`, `MODERATE_USERS`, `SUPPORT_USERS`, `MANAGE_STAFF`, `VIEW_AUDIT_LOG`), user edits check the right for each field, and staff can't grant a right they don't hold. `scripts/dev/staff-roles-probe.mjs` checks each default role over HTTP. |
| High | The legacy pin routes looked messages up by id alone, so pinning any message id in your own channel copied it into your pins, content included. Probe. | Pins look the message up inside the route's channel. |
| Medium | An account disabled by staff could re-enable itself through the undelete flow at login, two factor login or password reset. | Staff disables set the `DISABLED` user flag, and those three paths refuse to undelete an account that has it. |
| Medium | A gateway socket could send any opcode before Identify, including member, presence and channel status requests. Probe. | Only Heartbeat, Identify, Resume and QoS are accepted before Identify, anything else closes with 4003. |
| Medium | Op 14 sent presences for any user id listed in `members`, in any guild. Probe. | Presence lookups and subscriptions only include members of a guild the requester is in. |
| Medium | Voice channel statuses and channel info were sent for any guild id. | They need membership and only include channels the user can view. |
| Medium | Non-members could list a guild's channels, welcome screen channels and top read channels. Probe. | Those routes check membership. |
| Medium | Inbound gateway frames were inflated with zlib or zstd, so a small frame could expand without limit. | Inbound frames are never decompressed, and every socket gets a frame budget of 240 a minute. |
| Medium | Changing the case, adding slashes or percent-encoding a path gave it a fresh rate limit bucket. Probe. | Buckets are built from the decoded, lowercased path with empty segments removed. |
| Medium | The gateway read `X-Forwarded-For` from any peer. | It's read only from trusted proxies, by default loopback and private ranges, and `security.trustedProxies` narrows or widens that. |
| Medium | The TOTP code on the old disable path and on the application secret and bot routes could be guessed without a limit. | Direct codes outside the ticket flow are capped at 10 per user every 15 minutes. |
| Medium | The backup codes challenge put an unkeyed SHA-256 of a 4-byte key in the nonce, which can be brute forced offline. | The hash is an HMAC keyed from the instance's JWT key and the user id. |
| Low | Passwordless passkey sign in accepted assertions without user verification, and the ticket could be replayed. | User verification is required and the ticket is single use with 5 attempts. |
| Low | IPv6 clients got a bucket per address, so one /64 had billions of buckets. | IPv6 addresses share a bucket per /64, and IPv4-mapped addresses count as IPv4. |
| Low | Bots could fetch full member lists without the `GUILD_MEMBERS` intent and presences without `GUILD_PRESENCES`, and users could request unlimited full lists. | Intents are enforced and non-moderators get at most 100 members per full-list request. |
| Low | Gateway session ids and voice tokens came from `Math.random`. | They come from `crypto.randomBytes`. |
| Low | Pages had no framing policy, `nosniff` or referrer policy. Probe. | `frame-ancestors 'self'`, `nosniff`, `strict-origin-when-cross-origin` and HSTS over HTTPS. The widget stays embeddable. |
| Low | Request bodies logged with a 500 included passwords, tickets and message text. | Logged bodies redact those fields. |
| Low | Webhook routes checked `MANAGE_WEBHOOKS` on the guild and ignored channel overwrites, including when moving a webhook. | The check uses the webhook's channel and the channel it moves to. |
| Low | A prune count needed no permission, and the prune window accepted negative and non-numeric days. | Counting needs `KICK_MEMBERS` and the window stays between 1 and 30 days. |
| Low | Usernames went into HTML emails unescaped. | They are escaped. |
| Low | Every heartbeat wrote `last_seen` to the database. | It's written at most once a minute. |
| Bug | `GET /users/:id/messages` passed an undefined channel id when there was no shared DM, which TypeORM drops from the query, and the DM lookup itself failed on PostgreSQL. | The route returns an empty list without a shared DM and the lookup works on PostgreSQL. |
| Low | `POST /auth/forgot` answered 400 `EMAIL_DOES_NOT_EXIST` for unknown and deleted accounts and 200 for known ones, so anyone could check whether an email, phone number or username had an account. Probe. | Every login that passes the captcha gets 200 `{"method":"password_reset"}`, the answer the official client turns into its "check your email" notice. The reset email is sent in the background only for an account that has an email and isn't deleted, and the answer waits until 400 ms after the account lookup started, so known, unknown, disabled and deleted accounts take the same time. An empty login still gets the field error, which says nothing about accounts. |
| Low | Rate limits with a window under 60 seconds, and the instance-wide `ip`, `global` and `error` limits, were counted in process memory, so with several API processes each one allowed the full count. | When `EVENT_TRANSMISSION` or RabbitMQ is set, each process keeps counting in memory and writes the hits it saw to `rate_limits` in one batch every 250 ms, then takes the shared totals back and blocks a bucket that reached its limit. A single process writes nothing, as before. See the measurements below. |
| Low | Top-level routes such as `POST /error-reporting-proxy/web`, the status, legal and portal pages, `/healthz`, `/readyz`, `/.well-known`, `/_spacebar/api`, `/static` and `/widget` had no rate limit, and most anonymous routes under `/api` had only the instance-wide 500 requests every 5 seconds per address. Invite, template and data package lookups got a fresh bucket for every code, so guessing codes was only bound by that instance-wide limit. Probe. | Every top-level route has a limit, counted by address except on `/_spacebar/api`, which counts signed-in callers by account. Every `/api` route with `authentication: "never"` or `"optional"` has its own limit, by address for anonymous callers and by account otherwise. Most of these allow between 10 and 300 requests every 30 seconds and are counted in memory, so a health check or a page load costs no database write. Email verification links and data package downloads take tokens, so they are limited to 10 a minute in `rate_limits` and survive a restart. Invite lookups share one bucket of 30 every 30 seconds, template lookups 15 and data packages 10 a minute. `/federation/v2` stays exempt because unsigned requests and unknown instances are refused before routing and each instance has its own budget. A unit test fails when a new anonymous route has no limit. |
| Low | CORS reflected any `Origin` with `Access-Control-Allow-Credentials: true`. Requests authenticate with the `Authorization` header, which a foreign page doesn't have, but a banned user could send their own token from a page a victim opens, and the token check then propagated the instance ban to the victim's address and to the victim's `__sb_sessid` cookie, which the browser attached. Probe. | Only the instance's own origins, the request's host and the configured public API, CDN and admin endpoints, get credentialed CORS answers. Other origins are still reflected without credentials, so third-party web clients that send a token keep working, and every answer varies on `Origin`. A request from a foreign origin ignores the `__sb_sessid` cookie and never propagates bans, it is only refused. No route authenticates or changes state from a cookie alone: `__Secure-recent_mfa` only counts together with the same account's token and is `SameSite=Lax`. |
| Low | `PUT /guilds/:id/members/@me?lurker=true` sent `GUILD_CREATE` to any gateway `session_id` in the query string, so a user could push a discoverable guild into another user's client. Probe. | The event carries the caller's user id and the gateway drops it on a session that belongs to someone else. The gateway session id the client sends is never stored, so the check runs where the session lives instead of in the database. |
| Low | TypeORM runs with `invalidWhereValuesBehavior: { undefined: "ignore" }`, so an undefined `where` value matches every row. `POST /interactions` read `application_id` and `channel_id` from an unvalidated body, so a request without them used the first application and the first channel in the database, and with `register.allowMultipleAccounts` off a signup without a fingerprint matched every account and was refused as already registered. Probe. | The global setting stays, and `scripts/dev/undefined-where-audit.mjs` lists every `find`, `findOne`, `findBy`, `findOneBy`, `exists`, `count`, `update` and `delete` whose `where` takes a value from `req.params`, `req.query` or `req.body`. It accepts a value that is a parameter of the route path, a field the route's request schema requires, or one checked before the query, and 15 values in shared handlers that were checked by hand. Of 530 values it first found 18 unsafe. 4 in the two routes above were real and are fixed, 1 was a literal `undefined` that changed nothing and is gone, 12 were in shared handlers that are only mounted under the right path parameter, and 1 was checked in the `else` of a negated check that the first version of the script missed. `fetchInteractionMessage` also returns nothing for a missing id now. A unit test fails when a new unsafe value appears. |

## Not fixed

- `spamGuard.ts` and `admin/automod/names.ts` disable accounts without the staff disabled flag. They are in the automod area.
- CDN URL signatures are compared with `===` instead of a constant time compare, and `security.cdnSignUrls` is off by default.
- READY includes the names and topics of channels the user can't view, as Discord's own client expects.
- Staff with `VIEW_USERS` see email addresses, phone numbers and IP addresses. That is a policy choice.
- Staff role and membership changes reach other API processes only when their 10 second cache expires, so a revoked role keeps working there for up to 10 seconds.
- Reads in the dashboard are not hierarchy gated, so Support can open an Admin's account page.
- TypeORM still ignores undefined `where` values globally. Turning that off would turn every missed case into an error instead of a wider query, but the audit only follows request values into the route that reads them. A value passed through a helper function or read from a stored row isn't checked.
- With several API processes, shared rate limits can admit the requests one process gets within one 250 ms round before it sees the shared total. The two process unit test admits 11 requests against a limit of 10.
- `POST /auth/register` still says when an email is already registered and `/unique-username` says whether a username is taken, as Discord's own client expects. Both are rate limited by address.

### Measurements for shared rate limits

Measured with a local PostgreSQL on the owner's Mac. Counting a hit in memory takes 0.04 microseconds. One upsert into `rate_limits` per hit takes 0.06 to 0.1 ms one at a time and reaches about 37,000 a second over 16 connections, but only about 15,000 a second when every request updates the same row, which is what the per-address and per-account instance-wide buckets do. Every request touches two or three buckets, so a write per hit would add two or three row updates to each request and serialize busy clients on one row. One batched upsert of 500 buckets takes 4.4 ms. The design keeps the decision in memory and pays one statement per process every 250 ms, and only while there are new hits.

## Running the checks

```sh
bun run build:src
bun test scripts/tests/security-*.test.cjs
bun scripts/dev/route-audit.mjs --flagged
bun scripts/dev/undefined-where-audit.mjs
psql <your test database> -c "delete from rate_limits"
CHROME_PATH="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" PORT=3001 bun scripts/dev/security-probe.mjs
```

The probe registers two new accounts, so clear `rate_limits` on your own test database first. It prints `pass` for each blocked attack and exits with 1 when any attack works. `undefined-where-audit.mjs` prints the unsafe `where` values and exits with 1 when there are any, and `--all` also prints the accepted ones with the reason. Email verification reuse and the staff account checks need an email inbox or staff accounts, so they are covered by unit tests only.
