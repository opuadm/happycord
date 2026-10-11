# Link embeds

When a message has links in its content, the server builds embeds for them after sending the message and delivers them with a `MESSAGE_UPDATE`. Embeds need `externalRequests.thirdParty`, which is off by default, and `PUBLIC_FETCH_PROXY`, which [external-services.md](../self-hosting/external-services.md#hiding-the-servers-address) describes. Pages and media are fetched through cors.estrogen.delivery, and clients load embed media from it too. Built embeds are cached in the `embed_cache` table by normalized URL.

`src/api/util/utility/EmbedHandlers.ts` has a handler per host and a default handler for every other site.

| Link                                    | Embed                                                                                                                                                                       |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| YouTube watch, `youtu.be`, shorts, live | `video` built from YouTube's oEmbed answer. `video.url` is `https://www.youtube.com/embed/<id>` with no `proxy_url`, so the client opens YouTube's player in an iframe.         |
| Vimeo, Dailymotion                      | `video` from the page's `og:video` player URL, which has no `proxy_url` either.                                                                                               |
| A direct video file                     | `video` with the file behind cors.estrogen.delivery and a thumbnail from `/external/...?format=jpeg`, which renders the first frame with ffmpeg.                               |
| A page whose `og:video` is a video file | `video` with that file and the page's `og:image` as thumbnail.                                                                                                              |
| GIPHY, Tenor, KLIPY                     | `gifv` with the looping MP4. A same-host `<meta http-equiv="refresh">`, which GIPHY sends for renamed GIFs, is followed once.                                                |
| X and Twitter posts                     | `rich` with the text, author, reply, repost and like counts, and the first photo or the MP4 of the first video, the highest bitrate at or under 2.5 Mbps. With `external.twitter` set the official API is used instead of FixTweet. |
| An image file                           | `image` with the probed size.                                                                                                                                               |
| Other pages                             | `link`, `article` or `rich` from the Open Graph tags.                                                                                                                       |

The client plays a video with a `proxy_url` in a `<video>` element and opens any other video URL in an iframe. The server only leaves `proxy_url` off for player URLs on `youtube.com/embed/`, `youtube-nocookie.com/embed/`, `player.vimeo.com/video/` and `dailymotion.com/embed/video/`, and `proxyEmbedMedia` strips a stored `proxy_url` from those when it reads them, so embeds cached before this change play too. Any other video URL is proxied, so a bot can't make the client frame an arbitrary page.

A Twitch link stays a `link` embed. Twitch's player refuses to load unless its `parent` parameter names the embedding host, and the client replaces that parameter with Discord's own hosts.

## Components media

Messages with the `IS_COMPONENTS_V2` flag carry media in thumbnails, media galleries and file components. A file component must point at an uploaded attachment with `attachment://`, the same as Discord. Thumbnails and gallery items can also use any public URL.

The client only draws media whose `content_type` it knows. After the message is sent, the server sends a HEAD request for each remote URL that has no `content_type`, reads the type, probes the width and height of images and videos, sets `loading_state` to 2 and sends a `MESSAGE_UPDATE`. A source that answers 400, 401, 403, 404, 410 or 451 gets `loading_state` 3, which the client shows as not found. When the request can't be made, for example with `externalRequests.thirdParty` off, the type is guessed from the file extension. Until the update arrives, the API also fills `content_type` from the extension, so a `.png` or `.mp4` URL renders at once.

Remote images are served through cors.estrogen.delivery. Remote videos are served through the instance's `/external` proxy, because the client asks for a poster frame by adding `format=webp` to the video's `proxy_url`, and `/external` answers that with a JPEG of the first frame.

Links inside text displays are not unfurled, because a components v2 message can't have `content` or embeds. Discord behaves the same way.

## Tests

```sh
bun test scripts/tests/embed-video.test.cjs scripts/tests/media-privacy.test.cjs
```
