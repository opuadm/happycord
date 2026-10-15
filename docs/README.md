# Documentation

## Self-hosting

- [native.md](self-hosting/native.md): Linux hosting as a dedicated `meowcord` user, systemd restrictions, PostgreSQL, HTTPS, voice, backups and updates without Docker.
- [databases.md](self-hosting/databases.md): PostgreSQL and SQLite selection, migrations and backups.
- [setup.md](self-hosting/setup.md): native hosting entry point, Docker and development setup, and the first operator account.
- [deploy.md](self-hosting/deploy.md): production with Docker Compose, backups, updates, reverse proxies and phones.
- [external-services.md](self-hosting/external-services.md): every outside service the instance can contact and how each is turned on.
- [stickers.md](self-hosting/stickers.md): provisioning the standard sticker artwork locally and editing sticker packs.
- [verification.md](self-hosting/verification.md): how an instance gets approved, how instance admins verify servers for global discovery, and who can remove or block what.
- [registry.md](self-hosting/registry.md): the federation registry Worker, its endpoints, how we review instances and discovery servers, and how an instance gets listed.
- [change-url.md](self-hosting/change-url.md): moving an instance to a new address without losing its users, servers and DMs on other instances.

## Features

- [admin.md](features/admin.md): the admin dashboard at `/admin`.
- [activities.md](features/activities.md): embedded activities, their hosting and API.
- [announcements.md](features/announcements.md): encrypted announcements from the official account.
- [automod.md](features/automod.md): the slur auto-ban, word lists, join reasons, account approval, sign-in and signup limits, spam rules, raid detection, server AutoMod rules and the Automod admin page with its raid incidents.
- [captcha.md](features/captcha.md): Cap challenge work for registration, sign-in and password reset, and refusing automated browsers.
- [discovery.md](features/discovery.md): what Discover lists, how search and ranking work, the search index, categories and keywords.
- [e2ee.md](features/e2ee.md): end-to-end encrypted DMs, key backup and recovery.
- [federation.md](features/federation.md): Other instances in Discovery, chat with servers and people on other instances, the owner switch, the Federation admin page, its config keys and endpoints.
- [link-embeds.md](features/link-embeds.md): link previews, video players and components media.
- [homepage.md](features/homepage.md): the instance homepage at `/` and the settings that change it.
- [identity-moderation.md](features/identity-moderation.md): blocked words in usernames, display names and nicknames.
- [invites.md](features/invites.md): invite-only registration, member and staff instance invites, and invite trees.
- [loading-screen.md](features/loading-screen.md): custom loading tips and loading animation.
- [notifications.md](features/notifications.md): notification settings, mention counts, read states and Web Push.
- [pride-badges.md](features/pride-badges.md): the pride flag catalog and picking flags at signup.
- [profile-widgets.md](features/profile-widgets.md): application profile widgets made in the developer portal.
- [signup.md](features/signup.md): Cap verification on registration.

## Security

- [upload-limits.md](security/upload-limits.md): attachment upload slots and per-user staging limits.
- [upload-buffering.md](security/upload-buffering.md): memory admission for CDN uploads.
- [cloud-attachments.md](security/cloud-attachments.md): who can turn a cloud upload into a message attachment.
- [public-url-fetching.md](security/public-url-fetching.md): the bounded, DNS-pinned helper for outbound requests.
- [remote-media.md](security/remote-media.md): message component media downloads.
- [image-decoding.md](security/image-decoding.md): limits on images the server decodes itself.
- [security.md](development/security.md): the October 2026 security review, its findings and fixes, and how to run the route audit, unit tests and attack probe again.

## Development

- [client-patches.md](development/client-patches.md): how the Discord client is patched, built and checked.
- [native-ui.md](development/native-ui.md): shared native UI adapters for plugins.
- [dialog-dismissal.md](development/dialog-dismissal.md): how owned dialogs dismiss and how the developer portal handles late responses.
- [parity.md](development/parity.md): every Discord feature and its state here.
- [federation.md](development/federation.md): the plan for discovery and chat across instances. Phases 1 to 5 are built, including encrypted DMs and group DMs, and voice, video, Go Live and DM calls with DAVE across instances.
- [federation-protocol.md](development/federation-protocol.md): the version 1 contract between instances and the registry, and version 2 for chat between instances.
- [work-backlog.md](development/work-backlog.md): the task queue.
- [admin-api-coverage.md](development/admin-api-coverage.md): which API operations the admin dashboard covers, with the [machine-readable map](development/admin-api-coverage.json).
