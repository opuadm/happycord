# Component media downloads

Nothing calls the download path that `processMedia` implements, so remote component media is never copied into attachment storage. [link-embeds.md](../features/link-embeds.md#components-media) describes how the server reads the type and size of remote URLs instead and how clients load them. The checks below apply if the download path is connected again. `downloadRemoteMedia` connects from the server's own address and skips `PUBLIC_FETCH_PROXY`, so it has to move to `fetchPublicUrl` before anything calls it.

Message component images and files can use public HTTP or HTTPS URLs, or `attachment://filename` references to the sender's upload in the current channel. Attachment references do not make a remote request.

Remote component media resolves its destination before connecting. Every resolved address must be public, and the connection uses that validated address. Redirect destinations receive the same checks; three redirects are allowed. URLs containing credentials, private or reserved addresses, and mixed public/private DNS answers are rejected.

The download has a 15-second deadline covering DNS, redirects and the response body. Its byte ceiling is the smallest of `cdn.maxAttachmentSize`, `limits.message.maxAttachmentSize` and `limits.message.maxEmbedDownloadSize`. A nonpositive embed download limit uses a 5 MiB fallback. Both Content-Length and bytes actually received are checked before attachment storage.

Requests send `Accept-Encoding: identity`. Servers that still return a compressed HTTP response are rejected; this avoids counting compressed bytes as the size of an expanded file. Serve the actual image or file bytes without an HTTP content encoding.

Component media counts toward `limits.message.maxAttachments`. A message uses at most four media workers. A failure stops queued downloads, waits for work already running, and cleans temporary cloud uploads. Temporary uploads are also cleaned after successful cloning.

These checks cover component media in `processMedia`. They do not change collectible downloads, ordinary embed fetching, webhook avatar downloads or the shared `fetchPublicUrl` helper.

Run the targeted transport and handler regressions with:

```sh
bun test scripts/tests/remote-media.test.cjs
```

Changes to the message handler also require the full isolated E2EE suite described in [CONTRIBUTING.MD](../../CONTRIBUTING.MD).
