# Change your instance's URL

An instance's id is the lowercase host of its address, with the port when it isn't 443. Other instances store that id in every user, server and message they copied from yours: a user from your instance is `name@your.id` there, and every id is `@<snowflake>@your.id`. This page moves all of that to a new address without losing anyone's DMs, servers or friends.

The move works because your instance keeps its federation key. The key in `federation.key` signs a move statement that says "the instance that held this key as `old.id` is now `new.id`". Other instances and the registry check that statement against the key they have on record for the old id, so nobody can take over your id or your users with a pull request alone.

## Before you start

- Back up `federation.key` and `jwt.key`, and keep the same files on the new address. A new key turns the move into a key change, which needs a registry admin and the admins of every other instance to approve it by hand. See [If you lost the key](#if-you-lost-the-key).
- Point the new domain at the server and get a certificate for it.
- Keep the old domain pointing at the same server for at least a week if you still control it. Instances that haven't heard of the move yet keep sending to the old address, and your instance accepts requests signed for any of its previous ids.

## Steps

1. Change the address. Set `general.serverName`, `api.endpointPublic`, `cdn.endpointPublic` and `gateway.endpointPublic` to the new address, in `config.json` or on the Site settings page of the admin dashboard.
2. Add the old id to Previous ids on the Federation page of the admin dashboard, or to `federation.previousIds` in `config.json`. It takes up to 10 ids, one for each address the instance had before.
3. Restart the server. For each previous id the instance signs a move statement with its key and stores it, serves it in `moved_from` of `/.well-known/meowcord`, and about 10 seconds after the start sends it to every instance it shares a user, a server, a queued event or a peer entry with. It sends the statements again every 24 hours. The Instance moves card on the Federation page shows when each one was last sent and what the other side answered.
4. Open a pull request to `instances.json`. Change the entry's `id` and `url` to the new address, add `"previous_ids": ["old.id"]`, run `bun scripts/instances-md.mjs`, and commit both files:

    ```json
    { "id": "new.example", "name": "Meow", "url": "https://new.example", "source_url": null, "previous_ids": ["old.example"] }
    ```

    Remove the old entry in the same pull request. The registry refuses a move while the old id is still an entry of its own.

5. Once the pull request is merged, the registry imports `instances.json` within an hour, reads your new well-known document, checks the move statement against the key it has for the old id, and carries your approval, discovery servers, admin contacts and stats over to the new id. It publishes the move in its signed document, and every instance applies it the next time it fetches that document, which instances do every 5 minutes.

Instances apply a move as soon as either your instance or the registry tells them about it, whichever comes first. They don't need the registry to pick it up first.

## What other instances rewrite

Each instance that applies the move checks it on its own, against the key it has on record for the old id. The registry's word isn't enough: if the registry names a different key than the one an instance recorded, that instance refuses the move. Then it rewrites, in batches of 500 rows with one transaction per batch:

- The id mappings in `federated_objects`, so `@123@old.id` becomes `@123@new.id` and keeps the same local id.
- Shadow users: `name@old.id` becomes `name@new.id`.
- Mirror servers and channels, former group DM members and the e2ee keys it cached for your users.
- Queued events for your instance, its delivery counters and the event ids it already applied.
- Local blocks of your instance, servers and users. It copies them to the new id and keeps the old ones, so a move never lifts a block.
- Servers its admins verified for Discovery, and the peer list in `federation.peers`.

The rewrite can stop halfway, for example when the server restarts. The move then goes back to waiting and runs again on the next registry check, at most 5 minutes later, and rows it already rewrote are left alone.

A user someone looked up under the new id before the move arrived exists twice. The rewrite keeps the older copy, which has the history, moves the newer copy's server memberships, DMs, friends and messages onto it, and retires the newer copy as a deleted account named `moved-<id>`. Duplicate mirror servers and DMs are merged the same way. The Federation page lists each retired duplicate under the move.

After the move, a lookup of `name@old.id` and a mention of `@123@old.id` both find the same user. Requests that still come from the old id are refused with a message that names the new id. End-to-end encrypted messages sent before the move still verify, because the client also checks the signature with the old ids.

## If you lost the key

Without the old key nobody can prove the move, so it needs people to approve it.

1. Do the steps above. Your well-known document then serves a new key and no valid move statement.
2. In the pull request, explain what happened. A registry admin confirms with you that you run both addresses and approves the move on the Moves page of the registry admin. The registry then publishes it marked as approved by an admin.
3. Instances apply a key change only when the registry admins approved it. Before that, the move shows as Needs an admin on their Federation page, and their admins can press Apply after they checked with you.

A move statement signed with the old key that names a new key counts as a key change too and waits for a registry admin in the same way.

## Limits

- An id that moved can't be taken over by another instance. The registry refuses a second move of the same old id, and instances refuse a move to an id whose key they know and which differs from the key in the statement.
- A move back to an earlier id works the same way and ends the old alias. Chains of moves are followed for at most 8 hops.
- Shadow users and servers the other instance has never seen are created under the new id from the start.
- People who bookmarked the old address, and invites shared as links, keep pointing at the old domain. Redirect it to the new one if you can.
