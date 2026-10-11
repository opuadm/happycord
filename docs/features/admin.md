# Admin dashboard

The dashboard is served at `/admin/` and needs an account with the operator right. [setup.md](../self-hosting/setup.md#operator-account) explains how to grant it. It has pages for profiles, servers, the shop, sticker packs, badges, games, announcements, reports, status, moderation, security, site settings and performance.

## Navigation and editors

Navigation is grouped and searchable with Command+K or Ctrl+K. Editors open in drawers that contain focus, protect unsaved changes and have mobile layouts. Leaving a page cancels its pending requests.

Each form records its edit version before a request. A successful save clears the dirty state only when no later edit happened, so later text, checkbox, multiselect and file drafts stay protected. User and server editors refresh only while their original form is still connected, visible and clean, and a save that finishes after its drawer closed does not reopen it. At most three notifications show at once, and pointer events pass through them.

Closing a drawer restores focus to the control that opened it when that control is still connected, visible, enabled and outside inert content. Otherwise focus moves to dashboard search, or to the login field after sign-out. Cancelling the unsaved-edit confirmation leaves the drawer open. Dismissal restores both body overflow axes and their CSS priorities.

Returning to sign-in, for example after the session expires, cancels pending page reads, clears cached identity and view content and closes stale drawers even when they have unsaved edits. The Users and Servers lists keep their existing rows while refreshing and after a failed refresh, and Retry fetches the current query.

## Profiles and accounts

Profile controls cover usernames, display names, pronouns, bios, uploaded avatars and banners, profile colors, badges, instance rights, decorations, nameplates, effects and frames. Cosmetic selectors search local packs and render at most 100 matching options while keeping the current selection. Profile changes reach observers through the public user projection, so an open friend profile shows a changed banner.

With `MANAGE_USERS`, operators can also manage another user's pride badges, profile widget layout and client preferences. These routes keep the operator-target protection, the badge catalog validation and the widget eligibility rules. Every change writes a customization history entry with the actor, the target, the section and the changed field names, without raw preference values or secrets. Pride badge and widget changes commit together with their history entry. Preference writes keep the existing legacy and protobuf mutation flow and append the history entry after saving, so those two are not one transaction yet.

Admin user responses use an explicit projection that leaves out password hashes, session tokens, OAuth tokens, MFA secrets, private encryption keys, sealed backups and recovery codes. MFA reports only whether an authenticator is set up. Password-reset links are a separate explicit operator action.

[admin-api-coverage.md](../development/admin-api-coverage.md) maps which API operations the dashboard covers.

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
- [loading-screen.md](loading-screen.md) for loading tips and the loading SVG,
- [announcements.md](announcements.md) for encrypted announcements,
- [e2ee.md](e2ee.md) for encryption rate limits,
- [external-services.md](../self-hosting/external-services.md) for GIF search and other outbound requests.

Third-party integrations need `externalRequests.thirdParty`, and configured provider keys alone do not bypass it. A missing collectibles snapshot does not trigger a GitHub download. Operators who set `COLLECTIBLES_EXTERNAL_REFRESH=true` and a source URL still get remote catalog refresh; that environment switch is separate from the dashboard policy. Everything else is in the configuration file described in [deploy.md](../self-hosting/deploy.md#configuration-file).
