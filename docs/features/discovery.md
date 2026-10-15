# Server discovery

Discover lists the servers on this instance that are public, and the Other instances tab lists servers on other approved instances. [federation.md](federation.md) covers Other instances, where a listed server also shows its splash and its welcome screen in a preview before people join. This page covers how local discovery decides what to list, how search works and what a server owner can set.

## What gets listed

A local server shows up in Discover when all of these hold:

- It has the `DISCOVERABLE` feature, which the owner turns on and off in Server Settings, or `guild.discovery.showAllGuilds` is on.
- Its `discovery_excluded` column is false. No route sets it, so an operator excludes a server in the database.
- It isn't a mirror of a server on another instance. Those only appear under Other instances.
- When `guild.discovery.hideJoinedGuilds` is on, the person searching isn't a member of it.

Every request checks these on the `guilds` row itself, so a server that loses `DISCOVERABLE` or gets excluded leaves the results on the next request, even before the search index catches up.

## Search

`GET /api/v9/discoverable-guilds/search?query=...` searches names, descriptions and keywords. The query is cut to 100 characters and its first 6 distinct words are used. Words are compared without case or accents, so "Cafe" finds "Café", and each word matches as a prefix, so "synth" finds "synthwave". A server matches when every word matches a word in its name, description or keywords.

Results are ordered by:

1. Servers whose whole name equals the query, ignoring case, accents and punctuation.
2. The `discovery_weight` column, 0 unless an operator raises it in the database.
3. Servers with a message in the last 30 days.
4. Member count.
5. The most recent message.

`offset` and `limit` page through the results. `limit` defaults to 24 and is capped at 48. The answer has `total_count`, the number of matches across all pages. With `with_counts=true` it also has the number of matches in each primary category, which the client shows next to the category filter. `category_id` limits the search to one category.

`GET /api/v9/discoverable-guilds?categories=N` is what the category tabs call. It uses the same filters and ordering without a query and returns `total`. `GET /api/v9/guild-recommendations` returns the top of the same ordering.

## The search index

Search reads the `discovery_terms` table instead of scanning server names. It holds one row per word of each listed server's name, description and keywords, cut to 32 characters and at most 120 rows per server, plus one row for the whole name and one per category. A query word becomes a range over `term`, which both Postgres and SQLite answer from the table's primary key. On Postgres the column uses the `C` collation so that the range can use the index.

The instance rewrites a server's rows when it is created, when its name, description, features or discovery settings change, and when an admin edits it. Every 10 minutes, and 5 seconds after startup, it also walks every server in batches of 500 and fixes rows that drifted. Deleting a server deletes its rows through a foreign key.

## Categories and keywords

Server Settings, Discovery saves a primary category and up to 10 keywords of up to 30 characters each with `PATCH /api/v9/guilds/:id/discovery-metadata`. A category id that doesn't exist, more than 10 keywords or a longer keyword gets `400`. `PUT` and `DELETE /api/v9/guilds/:id/discovery-categories/:category_id` add and remove secondary categories, up to 4. These need Manage Server.

A category tab lists servers whose primary or secondary category is that category. Keywords only feed search.
