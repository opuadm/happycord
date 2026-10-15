# Admin dashboard

The dashboard is served at `/admin/`. Operators see every page, and [setup.md](../self-hosting/setup.md#operator-account) explains how to grant the operator right. Staff with a staff role or a narrower staff right see only the pages and controls their rights allow. It has pages for profiles, servers, the shop, sticker packs, badges, games, announcements, reports, automod, staff roles, the audit log, status, moderation, security, site settings and performance.

## Staff roles

A staff role is a named set of instance rights stored in `staff_roles`, with a position, a color and a badge switch. `staff_role_members` links accounts to roles. An account's effective rights are its own `rights` ORed with the rights of every role it holds. The REST middleware, the gateway and `getRights` all read effective rights through `src/util/util/StaffRoles.ts`, which caches the roles and their members for 10 seconds and drops the cache as soon as a role or an assignment changes in the same process. A role can never carry `OPERATOR`.

The first startup after the migration seeds four roles. Operators can rename, edit, reorder or delete them afterwards, and the seed never runs again.

| Role            | Position | Rights                                                                                                     | Badge |
| --------------- | -------- | ---------------------------------------------------------------------------------------------------------- | ----- |
| Admin           | 4        | `MANAGE_USERS`, `MANAGE_GUILDS`, `MANAGE_MESSAGES`, `MANAGE_STAFF`, `VIEW_AUDIT_LOG` and everything below  | yes   |
| Moderator       | 3        | `MODERATE_USERS`, `VIEW_MODERATION`, `VIEW_USERS`, `MANAGE_MESSAGES`                                       | yes   |
| Support         | 2        | `SUPPORT_USERS`, `VIEW_USERS`, `VIEW_MODERATION`, `RESEND_VERIFICATION_EMAIL`                               | yes   |
| Read-only audit | 1        | `VIEW_AUDIT_LOG`, `VIEW_MODERATION`                                                                        | no    |

The staff rights split what `MANAGE_USERS` used to cover alone:

| Right             | Bit | Allows                                                                                                    |
| ----------------- | --- | --------------------------------------------------------------------------------------------------------- |
| `VIEW_USERS`      | 51  | Search accounts, open an account, list addresses, badges, the shop catalog and instance invites.         |
| `MODERATE_USERS`  | 52  | Violations, suspensions, disabling, IP bans, report decisions, automod actions, join requests, raids.    |
| `VIEW_MODERATION` | 53  | Read reports, violations, IP bans and the automod pages.                                                  |
| `SUPPORT_USERS`   | 54  | Password reset links, turning off 2FA, signing out sessions and marking an email verified.               |
| `MANAGE_STAFF`    | 55  | Create, edit, reorder and delete staff roles and assign them.                                             |
| `VIEW_AUDIT_LOG`  | 56  | Read the staff audit log.                                                                                 |

`MANAGE_USERS` implies `VIEW_USERS`, `MODERATE_USERS`, `VIEW_MODERATION` and `SUPPORT_USERS`, and `MODERATE_USERS` implies `VIEW_MODERATION`, so accounts that already had `MANAGE_USERS` keep every page they had. `MANAGE_USERS` alone still covers profile and cosmetic edits, account deletion, automod settings, instance invites and the other instance-wide user settings. Instance configuration and the system pages still need `OPERATOR`.

Hierarchy:

- An account's level is the highest position among its roles. Operators are above every role.
- Staff can't act on an account whose level is at or above their own, can't assign or remove a role at or above their own, and can't create or move a role to their own position or above. Only operators can change their own roles.
- Staff can't put a right on a role that they don't have themselves.
- An account that holds staff rights directly in its `rights` column, without a role, ranks above every role, so only operators can act on it. An account with `MANAGE_USERS` and no role acts at level 0 and can act only on accounts with no staff rights.
- Reading an account is not hierarchy gated. Every write is.

The Staff roles page under Staff lists the roles by position with buttons to move them up and down. Opening a role edits its name, position, color, badge and rights, lists its members, adds members through a user search and deletes the role. The user drawer has a Staff roles card with a checkbox per role the viewer can assign. `scripts/ops/operator.mjs` still grants and revokes `OPERATOR` directly.

| Route                                       | Right                       |
| ------------------------------------------- | --------------------------- |
| `GET /api/v9/admin/staff/roles`             | `MANAGE_STAFF`              |
| `POST /api/v9/admin/staff/roles`            | `MANAGE_STAFF`              |
| `PATCH /api/v9/admin/staff/roles`           | `MANAGE_STAFF`, reorders    |
| `PATCH /api/v9/admin/staff/roles/:role_id`  | `MANAGE_STAFF`              |
| `DELETE /api/v9/admin/staff/roles/:role_id` | `MANAGE_STAFF`              |
| `GET /api/v9/admin/users/:user_id/staff-roles` | `VIEW_USERS`             |
| `PUT /api/v9/admin/users/:user_id/staff-roles` | `MANAGE_STAFF`, `role_ids` |

A role with the badge switch on puts a staff badge named after the instance and the role, such as "Meowcord Moderator", on its members' profiles through `GET /users/:user_id/profile`. Only the highest role with the switch on shows, and an account that already has the staff badge keeps that one.

`GET /api/v9/admin` returns the viewer's `access` keys, its `rights` and its `staff_roles`, and the dashboard hides navigation entries, pages, form fields and buttons the viewer can't use.

## Audit log

Every staff action is written to the existing `audit_logs` table with no guild: the actor, the target, the action, the area, the request body's keys and values with secrets redacted, and the time. The writes are:

- every successful `POST`, `PUT`, `PATCH` or `DELETE` under `/api/v9/admin`, recorded as the method and the route pattern, such as `PATCH /admin/users/:user_id`;
- every successful request on a route outside `/admin` that needs a staff right;
- staff role creation, edits, deletion, assignment and removal, as `staff_role.create`, `staff_role.update`, `staff_role.delete`, `staff_role.assign` and `staff_role.remove`;
- user customization edits and official messages, which already wrote there;
- actions where a staff right let someone past missing server permissions, such as deleting a message or editing a server they don't moderate. The entry names the right that was used.

Refused requests are not logged. The Audit log page under Staff reads `GET /api/v9/admin/audit-log`, which needs `VIEW_AUDIT_LOG` and filters by `actor_id`, `target_id`, `area`, `action`, `after` and `before`, newest first, 50 at a time with `before_id` paging.

Each entry has a `target_type` taken from the route parameter that named the target: `user` for `user_id` and `member_id`, `guild`, `report`, `automod_action`, `raid`, `violation`, `role`, `ban`, `channel` or `message`. An entry without a route parameter is a `user` when its target is an account, such as a staff role assignment. User targets come with a `target` summary and server targets with `target_guild`, the server's id, name and icon, which is null once the server is deleted. On the page the staff member and user targets open the user drawer and server targets open the server drawer. The user drawer has a Staff actions on this account button for staff with `VIEW_AUDIT_LOG`, which opens the log filtered to that account. `scripts/tests/admin-audit-targets.test.cjs` covers the target types.

## Navigation and editors

Navigation is grouped. Command+K or Ctrl+K focuses the search box at the top of the sidebar, which filters the pages and, from 2 characters on, also searches:

- people by username, display name, email, id, `@handle` or `name#1234`, local and from other instances, when you have `VIEW_USERS`;
- servers by name or id when you have `MANAGE_GUILDS`;
- an IP address, which offers to open the address and lists the accounts on it.

It shows up to 5 people and 5 servers with the total of each and a Show all matching accounts entry. The up and down arrows move through the results, Enter opens the highlighted person, server or address in its drawer, Enter with no results opens the first matching page and Escape clears the box. Closing the drawer puts focus back in the search box.

Editors open in drawers that contain focus, protect unsaved changes and have mobile layouts. Leaving a page cancels its pending requests. Every row that opens a drawer, in the users, addresses, servers, reports, invites, badges, games, shop, sticker pack and staff role lists, can be reached with Tab and opened with Enter or Space. Escape closes the drawer and focus returns to the row, or to the same row after the list refreshed.

Actions that delete, disable, ban, lift a ban, sign out or send to everyone ask first in a dialog that names the target, says what happens and has a button that names the action, such as Lift ban or Delete 3 accounts. Cancel has focus in dialogs for destructive actions and Escape cancels. Lifting an account's instance ban from the user drawer asks first too, which it didn't before. Only the unsaved changes prompts still use the browser's own dialog.

Notifications are announced through a `role="status"` region, and errors use `role="alert"`. Two actions offer Undo for 10 seconds: lifting a suspension restores the old end time if it hasn't passed yet, and lifting address bans bans the addresses again with their old reasons. Undo doesn't bring back the account bans that spread from a lifted address ban, and the notification says so.

Each form records its edit version before a request. A successful save clears the dirty state only when no later edit happened, so later text, checkbox, multiselect and file drafts stay protected. User and server editors refresh only while their original form is still connected, visible and clean, and a save that finishes after its drawer closed does not reopen it. At most three notifications show at once, and pointer events pass through them.

Closing a drawer restores focus to the control that opened it when that control is still connected, visible, enabled and outside inert content. Otherwise focus moves to dashboard search, or to the login field after sign-out. Cancelling the unsaved-edit confirmation leaves the drawer open. Dismissal restores both body overflow axes and their CSS priorities.

Returning to sign-in, for example after the session expires, cancels pending page reads, clears cached identity and view content and closes stale drawers even when they have unsaved edits. The Users and Servers lists keep their existing rows while refreshing and after a failed refresh, and Retry fetches the current query.

## Overview

The Overview page starts with five trend cards: Accounts, Servers, Messages in 24 hours, Online now and Open reports. Each card has a sparkline and the change against the period before it. Accounts, Servers and Open reports compare the last 7 days of new rows with the 7 days before. Messages compare the last 24 hours with the 24 hours before. Online now counts accounts with a session that isn't offline and was seen in the last 90 seconds, and its sparkline shows how many different accounts sent messages each hour. Every change has an arrow and a percentage. The arrow is green for a change in the good direction and red otherwise, and for open reports and automod actions a rise is the bad direction. Smaller cards below show memberships, disabled accounts, open incidents and, when there are any, users and servers from other instances. Open reports only shows to staff with `VIEW_MODERATION`.

The Activity section has one chart per metric, and each chart has its own 24 hours, 7 days, 30 days and 90 days switch. The dashboard remembers the last range per chart in the browser. A chart with one series draws bars, and a chart with more draws lines with a legend. Hovering, or focusing a chart and pressing the left and right arrow keys, shows the exact value of a bucket. Every chart has an `aria-label` that sums up its total and peak, and a Show the numbers section with the full table.

| Chart                     | Metric            | Counts                                                                                                    | Right                 |
| ------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------- | --------------------- |
| New accounts              | `accounts`        | Accounts registered here, without bots and shadow users, by their snowflake id                           | any admin right       |
| Messages sent             | `messages`        | Rows in `messages` by their snowflake id                                                                 | any admin right       |
| Active people             | `active_users`    | Different message authors per bucket. The headline counts different authors over the whole range        | any admin right       |
| New servers               | `servers`         | Servers created here, without mirror servers                                                             | any admin right       |
| Reports opened and closed | `reports_opened`, `reports_closed` | Reports by id, and resolved or dismissed reports by `resolved_at`                         | `VIEW_MODERATION`     |
| Automod actions           | `automod_actions` | Rows in `automod_actions` by id                                                                          | `VIEW_MODERATION`     |
| Federation                | `federation`      | New rows in `federated_objects` per instance, the 5 busiest instances and the rest summed as one line   | `OPERATOR`            |
| Attachment uploads        | `attachment_bytes`| Sum of `attachments.size` by id, plus the `instance` rows of the storage quota ledger as the stored total | `OPERATOR`            |

The server doesn't record federation requests per peer, so the Federation chart counts the ids each instance introduced, which grows with the users, servers and messages it sends. Shadow users and mirror server ids carry the remote creation time, so counting them by id would date them by when they were created on their home instance.

`GET /api/v9/admin/stats/timeseries` takes `metric`, `range` (`24h`, `7d`, `30d` or `90d`, 7 days by default) and `utc_offset` in minutes from -720 to 840 in steps of 15, which the dashboard sets from the browser so days start at local midnight. The 24 hour range has 24 hourly buckets that end with the current hour, and the others have one bucket per day that ends with today. Empty buckets are 0. Each series has `points`, `total` and `previous_total`, the total for the same length of time just before the range. The caller needs any admin right, then the right in the table above, and gets 400 for an unknown metric, range or offset. Results are cached in memory for 60 seconds per metric, range and offset.

Every query is bounded by time and uses an index. Rows with a snowflake id are counted by an id range on the primary key and bucketed by the id's timestamp, so no query reads `messages.timestamp` or `users.created_at`. Closed reports and federation ids are counted by `resolved_at` and `created_at`, which the `AdminTimeseriesIndexes1792961538274` migration indexes on PostgreSQL and SQLite. The bucket expressions use integer division on both backends and `EXTRACT(EPOCH ...)` or `julianday` for timestamp columns. Charts are inline SVG drawn by `assets/public/admin/overview.js` without a library, and redraw at the card's width when it changes.

`src/api/util/utility/adminTimeseries.test.ts` covers the bucket windows, the offsets, zero filling, the query validation and the rights per metric. `scripts/tests/admin-timeseries-route.test.cjs` covers the order of the access check, validation and caching in the route. On 2026-10-13 a fresh instance with 10,506 messages, 143 accounts, 26 servers, 60 reports, 400 automod actions and 1,800 federated ids over 90 days answered every metric and range in 1 to 8 ms, and the same queries returned the expected buckets on a fresh SQLite database.

## Profiles and accounts

Profile controls cover usernames, display names, pronouns, bios, uploaded avatars and banners, profile colors, badges, instance rights, decorations, nameplates, effects and frames. Cosmetic selectors search local packs and render at most 100 matching options while keeping the current selection. Profile changes reach observers through the public user projection, so an open friend profile shows a changed banner.

With `MANAGE_USERS`, operators can also manage another user's pride badges, profile widget layout and client preferences. These routes keep the operator-target protection, the badge catalog validation and the widget eligibility rules. Every change writes a customization history entry with the actor, the target, the section and the changed field names, without raw preference values or secrets. Pride badge and widget changes commit together with their history entry. Preference writes keep the existing legacy and protobuf mutation flow and append the history entry after saving, so those two are not one transaction yet.

Admin user responses use an explicit projection that leaves out password hashes, session tokens, OAuth tokens, MFA secrets, private encryption keys, sealed backups and recovery codes. MFA reports only whether an authenticator is set up. Password-reset links are a separate explicit action that needs `SUPPORT_USERS`.

The Users list sorts by newest, oldest or username, and the Servers list by newest, oldest, name or most members. `GET /api/v9/admin/users` takes `sort` as `newest`, `oldest` or `name`, and `GET /api/v9/admin/guilds` takes `newest`, `oldest`, `name` or `members`, and both return 400 for anything else. Ties sort by id. A user search for `@name` ignores the `@`, and `name#1234` matches the username and the exact discriminator. Both lists show the number of results and page 50 at a time.

`PATCH /api/v9/admin/users/:user_id` checks each field: `disabled`, `suspended_until`, `account_standing` and `join_status` need `MODERATE_USERS`, `verified` needs `SUPPORT_USERS`, `rights` needs `OPERATOR`, and every other field needs `MANAGE_USERS`.

[admin-api-coverage.md](../development/admin-api-coverage.md) maps which API operations the dashboard covers.

## Users and servers from other instances

When someone here joins a server on another instance or talks to someone there, this instance stores the people they meet as shadow users named `name@instance`, and the servers they join as mirror servers. The other instance owns those profiles and servers, so the dashboard keeps them apart from local ones and doesn't edit them.

- The Users page has three tabs. Accounts lists accounts registered here, Other instances lists shadow users with their home instance, and IP addresses lists addresses. `GET /api/v9/admin/users` and `GET /api/v9/admin/users/bulk` take `origin`: `local` by default, `remote` for shadow users or `all` for both. A search for an exact id ignores `origin`, so a pasted id always finds its account.
- The Servers page has a Servers tab for servers hosted here and an Other instances tab for mirror servers. `GET /api/v9/admin/guilds` takes the same `origin`.
- The overview counts Users, Servers and Disabled accounts on this instance only, and shows Users from other instances and Servers on other instances as separate numbers when there are any. `GET /api/v9/admin` returns them as `remote_users` and `remote_guilds` next to `users` and `guilds`.
- A shadow user's drawer shows the profile read-only with its home instance and federated id, a Disabled here switch, the suspension when there is one and a button that deletes this instance's copy. It links to the Federation page for blocking the user or their instance. Profile, email, rights, standing, security, sessions, invites and customization controls don't show.
- A mirror server's drawer shows its host, federated id, owner and counts read-only, links to the Federation page and has a button that deletes this instance's copy.

The API refuses edits the home instance owns with HTTP 400 and a message that names the home instance, so a request from an old page or a script fails instead of reporting success. For a shadow user, `PATCH /api/v9/admin/users/:id` accepts only `disabled` and `suspended_until`, which the relay and the token check both enforce here. Pride badges, profile widgets, client preferences, two-factor resets, password reset links, extra invites and new violations are refused. Ending sessions, resolving or removing existing violations, bulk disable and delete, and deleting the account still work. For a mirror server, `PATCH /api/v9/admin/guilds/:id` and creating or editing its channels and roles are refused, and `DELETE` still removes the local copy. Deleting a copy doesn't block anyone: a shadow user comes back when they talk to someone here again, so block them on the Federation page to keep them out.

`scripts/tests/admin-federated-accounts.test.cjs` covers the refusals and the counts. `scripts/dev/federation-probe.mjs` checks the default and remote user lists, a refused profile edit and password reset of a shadow user, disabling and enabling it, the overview and stats counts, the two server lists and a refused edit of a mirror server, and passed all 144 checks on 2026-10-13.

## Removing spam accounts

The Users page has checkboxes on every row. The header checkbox selects the page, and once the whole page is selected a button selects every account that matches the search and filter, up to the newest 5,000. The bar above the list then disables or deletes the selected accounts. Disabling can also delete every message they sent, which needs `MANAGE_MESSAGES`. Deleting always removes their messages, because the database deletes them with the account. The confirmation names the exact number of accounts.

- `POST /api/v9/admin/users/bulk` takes `user_ids` (1 to 500), `action` (`delete` or `disable`), `delete_messages`, `ban` and `reason`, and needs `MODERATE_USERS`. Deleting also needs `MANAGE_USERS`, and accounts at or above the caller's staff level are skipped. The dashboard sends 100 ids per request and shows its progress. The response lists the processed ids, the skipped ids with a reason (`unknown`, `self`, `operator` or `failed`), the number of deleted messages and the number of ended sessions.
- `GET /api/v9/admin/users/bulk` returns the ids behind a search. It takes the same `q`, `ip`, `filter` and `origin` as the user search.
- Your own account is always skipped, and operators are skipped unless you are an operator.
- Accounts are handled in batches of 50. Disabling sets `disabled`, ends every session with `SB_SESSION_REMOVE` and then deletes messages. Deleting goes through the same code as the single-account delete in the user drawer: it ends sessions, deletes messages, removes DMs and group DMs, hands owned servers to the member with the highest role or deletes them when nobody is left, removes server memberships with `GUILD_MEMBER_REMOVE` and deletes the account.
- Messages are deleted 500 at a time with one `MESSAGE_DELETE_BULK` per channel, so open clients drop them right away.
- The server log records who ran each bulk action and which ids it changed.

## IP addresses

Registration stores the address it came from in `users.registration_ip`, using the request address Express gives after the `security.trustedProxies` setting. Sessions keep the last address they were used from in `last_seen_ip`. Accounts made before this column existed show only their session addresses, and a session's address goes away when the session ends.

- The user drawer shows the registration address and every address the account's sessions used, with the last time each was seen, how many accounts share it and whether it is banned.
- Typing an address into the Users search, or passing `ip`, lists the accounts that registered on it or have a session from it. `::ffff:203.0.113.7` and `203.0.113.7` are the same address.
- The IP addresses view of the Users page, `GET /api/v9/admin/ips`, lists addresses with the most accounts first, with the number of accounts, how many registered there and when the address was last seen. `q` filters by the start of an address.
- Opening an address shows its accounts and removes all of them with the same bulk endpoint. It bans the address too unless you untick that.

## Client addresses

Site settings has a Client addresses card. Rate limits, address bans and the accounts per address limit all use the address it picks.

- Address header picks `security.forwardedFor`. Automatic, the default, reads `X-Forwarded-For` from trusted proxies and then `CF-Connecting-IP` when the connection comes from one of Cloudflare's published ranges. The other choices are `X-Forwarded-For`, `CF-Connecting-IP`, `True-Client-IP`, `X-Real-IP` and `Fly-Client-IP`. The server reads the header only when the connection comes from a trusted proxy or from Cloudflare, so a visitor can't set their own address.
- Trusted proxies sets `security.trustedProxies`, a comma separated list of addresses, CIDR ranges or the names `loopback`, `linklocal` and `uniquelocal`. Blank means all three names. It takes effect after a restart.
- The API, CDN and gateway use the same rules. Private and Cloudflare addresses never count toward the accounts per address limit.

## IP bans

IP bans are `instance_bans` rows with `ip_address` set. `GET /api/v9/admin/ips/bans` lists them, `POST` to the same path adds one, `DELETE /api/v9/admin/ips/bans/:ban_id` lifts one and `POST /api/v9/admin/ips/bans/lift` lifts up to 100 at once. Listing needs `VIEW_MODERATION`, and adding and lifting need `MODERATE_USERS`.

The IP bans tab of the Users page shows to staff with `VIEW_MODERATION`. It has a form to ban an address, a search by the start of an address, a Show filter for all bans, bans set by staff and bans that spread from another ban with the count of each, and pages of 50. Each row shows the address and reason, the kind, the account a spread ban belongs to, the ban it spread from and how many bans an explicit ban spread to. Addresses open the address drawer and accounts open the user drawer. Checkboxes select bans across pages, and Lift bans lifts the selection after one confirmation.

- `GET /api/v9/admin/ips/bans` takes `kind` (`all`, `explicit` or `spread`), `q` for the start of an address, which also matches the `::ffff:` spelling, `limit` up to 100 and `offset`. The response has `total`, `counts` with the number of `explicit` and `spread` address bans, and per ban `origin_ban_id`, `origin` with the source ban's id, address, account and reason, `user` with the account summary and `spread_count`. An unknown `kind` or a `q` that isn't the start of an address returns 400.
- `POST /api/v9/admin/ips/bans/lift` takes `ban_ids`, 1 to 100 ids. Each address ban is lifted with the bans it spread, the same as the single `DELETE`. The response lists the lifted bans with their address and reason in `lifted`, the ids that matched no address ban, such as account bans or unknown ids, in `missing`, and the number of spread bans lifted with them in `spread_lifted`.
- `scripts/tests/admin-ip-bans.test.cjs` covers the filters, the source and spread fields, the bulk lift and the single lift.

- Registration from a banned address returns 403 before the captcha is checked. Password sign-in checks the address after the password, so staff can still sign in from it.
- Tokens already issued stop working when they are used from a banned address. The account that used one gets an instance ban of its own, and a banned account that signs in from a new address or browser bans that address or browser too. Each spread ban names the ban it came from. Only bans that staff or automod made spread, and only one step, so someone who shares a network with a banned account can be refused from that network but never gets an account ban of their own. Spread browser bans expire after 7 days, while a spread account ban stays until staff lift it. Migration `1792946027519-CascadedBans` removes the bans that spread from other spread bans before this rule. Lifting the address ban also lifts the bans it spread.
- Staff accounts, meaning operators, accounts with any staff right and members of a staff role, are never caught by address or browser bans and never spread one. A ban on the staff account itself still applies, so remove someone from staff before banning their address.
- Users from other instances reach this server through the federation relay on loopback, so their requests never match or spread an address or browser ban. Another instance can't ban anyone here. Only this instance's staff can.
- A banned account never bans the addresses it uses. Address bans only come from staff, on the IP bans list or through a raid action. Before this, every request from a banned account banned its address, so one banned WARP user or one Cloudflare edge address in front of the server filled the IP bans list and locked out everyone behind it. Migration `1792958814063-AutomaticAddressBans` deletes every address ban that spread automatically and every ban that spread from one.
- Cloudflare's published ranges count as shared addresses too, so they never match a ban and can't be banned.
- Private, loopback and shared addresses, such as `127.0.0.1`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` and `100.64.0.0/10`, never match a ban and can't be banned. Behind a reverse proxy without the right `security.trustedProxies`, every request comes from the proxy's address, and before this rule one ban on it locked out every account. Migration `1792931468207-SharedAddressBans` removes the bans that spread that way and everything they spread to.
- You can't ban the address you are using.

The user drawer's Instance bans card lists the bans on an account, marks the ones that spread automatically and has a Lift ban button for each. `DELETE /api/v9/admin/users/:user_id/instance-bans/:ban_id` lifts one together with the bans it spread, and needs `MODERATE_USERS`.

## Instance invites

Instance invites under People & servers lists the codes that let people sign up, creates staff invites and revokes an invite, optionally disabling the accounts that joined with it or the whole branch below it. The user drawer's Invites card shows who invited the account, its remaining invites with an Extra invites field and the tree of accounts it brought in. [invites.md](invites.md) has the details. Site settings has the invite-only switch and the member invite limits under Registration, and the captcha challenge settings and Block automated browsers under Captcha, see [captcha.md](captcha.md).

## Servers, channels and roles

Server controls cover artwork, descriptions, locale, verification and content filtering, notifications, premium tier, NSFW and AFK settings and feature flags. "Manage channels and roles" edits channel names, topics, categories and slow mode, and role names, colors and permission bits. It also creates categories, text, voice and community channels and roles, with validated permissions and the instance limits. Lists report truncation above 1,000 resources.

## Shop

The catalog editors manage custom packs and items and local overrides for mirrored packs. The compact catalog response is serialized once per snapshot and supports private conditional ETags. Prices are always zero.

- Mirrored packs can get local names, summaries, order, banners and logos. The overrides sit on top of the local catalog and leave the vendor item metadata intact. Uploaded artwork is served locally. Reset restores the original metadata and artwork URLs and removes the local banner and logo files, without changing the pack's visibility. A hidden built-in category leaves the shop but keeps product lookup and equipped decorations working.
- Custom items can change position or move to another custom pack and keep their ID, artwork and settings. Equal positions and creation times sort by numeric ID.
- Names and summaries are trimmed. Blank names, fractional positions, invalid artwork, unknown palettes, excessive effect durations and excessive frame overflow return 400.
- Frame uploads prepare every new layer before deleting an old one, and a refused upload removes the layers it already accepted.
- Deleting a custom item or pack clears its avatar decoration, nameplate, profile effect and profile frame from global and server profiles in the same transaction. Deleted IDs are recorded in `store_item_deletions`, and PostgreSQL guards stop later profile writes from restoring them. Artwork removal starts only after the transaction commits.

## Sticker packs

The Sticker packs page manages the packs every account gets in the sticker picker, below the stickers of its servers. Packs imported from Discord and packs made on the instance are in one list and are edited the same way. [stickers.md](../self-hosting/stickers.md) covers importing Discord's catalog and its artwork. The routes are under `/api/v9/admin/sticker-packs` and need the operator right.

- A pack has a name, a description, an order number, a cover sticker and a "Show in the picker" switch. Packs sort by order number, lowest first, then by ID, oldest first. A new pack gets 0, so it comes after the imported packs until it gets a lower number.
- Hiding a pack takes it out of the picker. Messages that used its stickers keep them and the artwork stays served. Deleting a pack deletes its stickers and their artwork and removes those stickers from the messages that used them, so hide a pack to retire it.
- A pack without stickers stays out of the picker.
- "Add stickers" takes one or more PNG, APNG, GIF, WebP or Lottie JSON files of at most 4 MiB each, and each file becomes a sticker named after it. Other formats, such as JPEG, return 400. A Lottie file returns 400 when it names an address outside the file or an image it does not embed.
- A sticker has a name of 2 to 30 characters, a description of up to 100 characters, search words of up to 200 characters and an order number inside its pack. It can move to another pack and keeps its ID and artwork. Its artwork can be replaced, and browsers that already loaded the old artwork keep it for up to 6 hours.
- Moving or deleting the cover sticker of a pack resets the cover to the first sticker.
- The checkboxes in the list hide, show or delete several packs at once.
- A pack holds up to 200 stickers and an instance up to 500 packs.
- Lottie stickers show a placeholder in the dashboard, because it has no Lottie player. The client plays them.
- An open client fetches the packs again after an hour and picks up new and edited packs then. A hidden or deleted pack stays in an open client until it reloads.
- While `externalRequests.discordStickerPacks` is on, an instance with no packs at all imports Discord's catalog again. Hide the imported packs instead of deleting every pack, or turn that setting off first.

## Reports

The Reports page lists what people sent from the client's Report menus, newest first, filtered by status or by the reported user. The server decides what each report points at, so a reporter can't attach a server, channel or message they made up:

- A message report needs a message the reporter can see. The author, server and channel come from the stored message, not from the request.
- Server, discovery and directory reports blame the server's owner. Event reports blame the event's creator, and the reporter has to be in that server. App reports blame the app's owner.
- A stage report names a speaker only if that person is in the server.
- A user report keeps a server only when the reporter and the reported user are both members of it, and drops any channel or message id.
- Reporting the same thing again while the first report is open updates that report instead of adding a second one, so one account can't stack the count.
- Another instance can file an "Automod on another instance" report about a local account when that account trips an automod rule there. It has no reporter, the reason names the instance, the rule and the action, and the reported content is the masked excerpt. [automod.md](automod.md#federation) explains the limits.

Message reports save the 15 messages before the reported one and the 10 after it, as they were at report time, so deleting the conversation later doesn't remove the context. In encrypted channels the reporter's client also shares the keys of the context messages it can read, and the server checks each one the same way as the reported message. A context message the reporter couldn't read is saved without its text.

The report drawer shows:

- how many open reports point at the same message or user and from how many people, with an option to close all of them at once;
- the reported user's join date, active and total violations, and how often they were reported and how often those reports were upheld;
- how many of the reporter's past reports were upheld or dismissed, with a "Mostly dismissed" badge for someone with at least 5 dismissed reports and three times as many dismissed as upheld.

## Automod

The Automod page sits under Reports in the sidebar. Reading it needs `VIEW_MODERATION`, acting on accounts needs `MODERATE_USERS` and changing its settings needs `MANAGE_USERS`. It shows how many actions automod took in the last 24 hours and 7 days by rule, the automod log with filters, undo and "not a match", join requests with low-effort badges and bulk approve and reject, a review queue for the last 24 hours with confirm and undo, hit counts and false positive rates per rule, a box to test text, an email, a username and an address against every rule, a form for each group of automod settings including scam links, signup scoring, the new account quarantine, server verification and explicit media, accounts per address and federation reports, a lookup of the accounts on one address and a scan of existing names with bulk disable. Its Raids section lists live and recent spam and raid incidents across servers and the accounts caught most this week, and acts on every account in an incident at once: delete their messages, suspend, disable or ban their IP addresses. The users list can be filtered to suspended accounts, accounts waiting for approval and accounts that gave a join reason, and the user drawer shows the join reason and can lift a suspension. [automod.md](automod.md) has the rules.

## Slowmode

Sends in a slowmode channel serialize per user and channel across processes with a PostgreSQL transaction advisory lock. The send rechecks the cooldown and saves the message, read state, member and channel pointers and a successful-send marker in one short transaction. A failed send rolls these back and uses no cooldown. The marker expires after six hours, the longest channel slowmode, and the current channel setting decides how much cooldown remains. Deleting the last message does not reset the cooldown.

Slowmode applies to owners, administrators and members with Manage messages, Manage channels or Bypass slowmode. Turning on `limits.channel.allowSlowmodeBypass` in Site settings restores those permission exemptions. Edits and webhook messages do not use the cooldown. A rejected send returns HTTP 429 with code 20016 and `retry_after` in seconds, and the client shows its countdown and keeps the draft.

## System

The System page needs the operator right. It shows the bundled client and its patch check, link previews, voice and the Shop catalogue. The Link previews card reads `GET /admin/system/network`, which reports whether `PUBLIC_FETCH_PROXY` names a SOCKS5 proxy, says `direct`, is unset or is invalid, whether that proxy accepts a TCP connection within 2 seconds, and whether `externalRequests.thirdParty` is on. With the variable unset or invalid, link previews and components media fail, and the card says so.

## Performance

The Performance page needs the operator right. It reports this process's uptime, memory, event-loop delay, database connectivity, mean route latency, request counts, 5xx errors and rate limiting. These are process-lifetime numbers, not distributed telemetry or per-route percentiles. Overview counts refresh every 30 seconds, and the revision is read once at startup.

## Where settings live

Site settings expose user, guild, message and channel limits, default server features and the external request policy. Feature pages describe the settings they own:

- [signup.md](signup.md) for Cap mode and registration policy,
- [identity-moderation.md](identity-moderation.md) for blocked identity words,
- [automod.md](automod.md) for the Automod page, its log and join requests,
- [loading-screen.md](loading-screen.md) for loading tips and the loading SVG,
- [announcements.md](announcements.md) for encrypted announcements,
- [e2ee.md](e2ee.md) for encryption rate limits,
- [external-services.md](../self-hosting/external-services.md) for GIF search and other outbound requests.

Third-party integrations need `externalRequests.thirdParty`, and configured provider keys alone do not bypass it. A missing collectibles snapshot does not trigger a GitHub download. Operators who set `COLLECTIBLES_EXTERNAL_REFRESH=true` and a source URL still get remote catalog refresh; that environment switch is separate from the dashboard policy. Everything else is in the configuration file described in [deploy.md](../self-hosting/deploy.md#configuration-file).
