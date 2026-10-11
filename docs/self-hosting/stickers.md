# Local standard stickers

Standard sticker pack metadata does not include its artwork. An instance with imported metadata but no local sticker files displays failed tiles in the native picker when outbound sticker requests are disabled.

Provision the official catalog and artwork once, then serve them locally:

```sh
DOTENV_CONFIG_PATH=/path/to/instance/.env bun scripts/provision-stickers.mjs --import-catalog
```

If the standard catalog is already present, omit `--import-catalog`. This operator command contacts only Discord's official catalog API and static CDN. It does not change runtime network settings. Existing pack metadata and artwork are preserved. It currently supports PostgreSQL and file storage; set `STORAGE_LOCATION` to the instance's actual file storage directory when it differs from the environment file's sibling `files` directory.

The provisioner uses four workers, a 15-second request timeout, a 4 MiB per-artwork limit and a 256 MiB download/cache budget. Redirects are rejected. Lottie animations must be valid, self-contained documents: remote URLs and unresolved image paths fail validation. A local manifest records each asset's format, byte count, canonical source and SHA-256 checksum. Reruns validate existing files against those pins and download only missing files. A partial run exits unsuccessfully and reports failed sticker IDs; correct the cause and rerun. Do not commit the artwork cache to Git. Back up the storage directory and its manifest with other instance data.

The local CDN serves installed standard and custom guild stickers before considering any upstream fallback. Runtime fallback for canonical Discord sticker artwork requires `externalRequests.discordStickerPacks` explicitly enabled; the broader asset fallback switch does not override that choice. The default remains disabled.

Check the native picker on an isolated instance with:

```sh
DOTENV_CONFIG_PATH=<isolated .env> bun scripts/dev/sticker-picker-smoke.mjs --trace
```

It registers two disposable accounts through Cap, accepts their friendship, logs in through the native client, creates one temporary guild and PNG sticker, checks Lottie, APNG and custom PNG rendering, and removes only its own fixtures. `--send` also sends each tile and checks the recipient's message, its decrypted sticker format and its decoded artwork.


## Editing packs

Operators add, edit, reorder, hide and delete sticker packs on the Sticker packs page of the admin dashboard. [admin.md](../features/admin.md#sticker-packs) describes it. Imported packs are ordinary rows there, so they can be renamed, reordered, hidden or deleted like the instance's own packs.

Stickers uploaded in the dashboard are marked in the `stickers.pack_upload` column. The provisioner skips them: it does not validate them, count them toward its limits or list them in its manifest. The CDN never asks Discord for their artwork. Uploaded artwork is stored in the same `stickers` storage directory as the provisioned artwork, so one backup covers both.

Rerunning the provisioner with `--import-catalog` adds back official packs and stickers that were deleted. It leaves existing rows as they are, including a pack's name, order and hidden state, and it does not put stickers back on messages.
