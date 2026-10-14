# Profile widgets

The Board tab of a profile shows widgets. The client already ships the game widgets (favorite games, games in rotation and so on) and the application widget, the card a game or app puts on your profile with a greeting, an image and four items, six stats or a progress bar, and a smaller version of it in the profile popout. Discord only lets partner apps make application widgets. Here anyone can make one in the developer portal and put it on their own profile.

## Making one

On `/developers/applications`, New profile widget creates an application named after you, with your avatar as its icon, and opens its Profile Widget page. Any existing application has the same page. The card's header shows the application's name and icon, so that's what most people set to their own.

The page edits the three parts of the card and draws them next to the form the way the client lays them out:

- Top: a title, up to three lines under it and an image, either large and cut out or square.
- Bottom: four items with an icon, a name and a description, six stats with a label, or a progress bar.
- Profile popout: one line and an image, which defaults to the top image.

Add to my profile puts it on your Board. It also shows up in the client's Add Widget picker under Your Profile Widgets, a tab `FosscordApps` adds for widgets of applications you own.

Text fields hold fixed text, or `{{key}}` to show a value set for each person. The Your values card sets your own, and the application's bot sets anyone's (see below). Numbers are formatted in the reader's language. The progress bar always reads its numbers from values.

The client draws a loading placeholder where a layout's text is missing, so the page asks for a title, every item's name and description, all six stats or the goal before it saves.

By default only the owner can add a widget. Let anyone add this widget makes it public, which is meant for apps that fill in values for each person. Anyone the application has values for can also add it.

## Values from a bot

| Route                                                             | Use                                                                                    |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `GET /applications/:application_id/users/:user_id/widget-data`    | The values set for a user.                                                             |
| `PUT /applications/:application_id/users/:user_id/widget-data`    | Replaces them. Body `{ "data": { "visits": "10M+", "level": 12 }, "username"?: "…" }`. |
| `PATCH /applications/:application_id/users/:user_id/widget-data`  | Changes the keys it sends. A key set to `null` is removed.                             |
| `DELETE /applications/:application_id/users/:user_id/widget-data` | Clears them.                                                                           |

The application's bot token (`Authorization: Bot <token>`) or the owner's own session can call them, and `@me` works as the user id. Up to 50 keys of letters, numbers and underscores, each a number or a string of up to 256 characters.

## What the client reads

| Route                                               | Use                                                                                                                                                                  |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /applications/:application_id/widget-configs`  | The widget's layout for each surface, its images (`resolved_assets`) and `owned` for the viewer.                                                                     |
| `GET /widget-configs/featured`                      | Widgets for the Add Widget picker: your own, public ones and ones that have values for you.                                                                          |
| `GET /widget-configs/developer`                     | Your own widgets. The client asks for these with developer mode on.                                                                                                  |
| `GET /users/:user_id/application-identities`        | The values behind each widget on a profile. Every widget on the profile and every widget of the user's own applications gets an entry, values or not, so it renders. |
| `POST /applications/:application_id/widget/refresh` | No-op, the values are read on every profile fetch.                                                                                                                   |

The portal saves the layout with `PUT /applications/:application_id/widget-config` and uploads images with `POST /applications/:application_id/widget-config/assets`. Both are owner only. The layout is checked against the layouts the client knows (`WIDGET_LAYOUTS` in `src/api/util/handlers/ApplicationWidgets.ts`), and saving deletes uploaded images no field uses any more. The images are served from `/app-assets/<application id>/<asset id>`, like Rich Presence assets.

`PUT /users/@me/widgets` only takes an application widget the user may add, once per application.

## Reports

The ⋯ menu on someone else's widget has Report Widget. For an application widget the report stores the application id and a snapshot of the widget's text and images as the reporter saw them, and the admin panel shows it as Reported widget.

## Custom game profiles

Operators create and edit custom games on the dashboard's Games page. Publishers and developers appear in game profiles as companies with their respective roles. The API and gateway load the game catalog before accepting requests, so game mentions in the first message response contain the game name and profile metadata.

Creating, editing or deleting a custom game clears the merged catalog and waits for its replacement before the admin response completes. Later message responses use the updated metadata without needing a game API request to warm the cache. Game detail responses use `Cache-Control: no-store`. The required FosscordGameRefresh plugin fetches the latest record when a game profile opens.

`scripts/tests/game-profile-cache.test.cjs` covers shared initial loading, publisher edits, deletion and a catalog read overlapping an edit. A live check on a disposable SQLite database verified cold API startup and admin publisher edits and deletion without an intervening game API read.
