# Homepage

The server answers `/` with the instance homepage. `src/util/util/HomePage.ts` fills the template in `assets/public/index.html` on every request, so a config change shows up on the next page load without a restart.

The left column has the instance icon and name, a tagline and the sign-up and sign-in buttons, and it stays in place while the right column scrolls. The right column has four feature highlights and the FAQ. Under the footer, a drawn app window with the instance's icon and name is cropped by the bottom of the page. A pixel cat sits on its top edge, and a canvas draws a dithered glow in the accent color behind it, in 3px cells with an 8x8 Bayer pattern. The window, the cat and the glow are decorative and hidden from screen readers.

These settings change what the page says:

| Setting                                               | Effect                                                                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `client.instanceName`, `client.icon`                  | The name and icon in the header, the headline, the preview and the FAQ.                                                   |
| `general.instanceDescription`                         | Replaces the default tagline and the page's meta description.                                                             |
| `register.disabled`, `register.allowNewRegistration`  | Either one closes registration. The page then shows only Sign in and says new accounts are closed.                        |
| `register.requireInvite`                              | The note under the buttons and the "How do I join?" answer explain that an invite link is needed.                         |
| `general.correspondenceEmail`                         | Adds a Contact link to the footer and the address to the "Who runs" and closed-registration answers.                      |

The FAQ has seven questions in `<details>` elements, so it works without JavaScript. With JavaScript the list shows four questions, fades the fifth and adds a Show more button that reveals the rest. Browsers that support `::details-content` animate the height when a question opens, unless the reader has reduced motion turned on. The footer links to `/terms`, `/privacy`, `/guidelines` and `/status`, and keeps the fixed Meowcord credit.

## Link previews

The homepage and every `/invite/<code>` page carry Open Graph and Twitter Card tags, so Discord, Slack, messaging apps and other sites show a card with a title, a description and an image instead of a bare URL. `src/util/util/OpenGraph.ts` writes the tags and `src/api/util/utility/invitePreview.ts` looks up the invite.

The homepage card uses the instance name, `general.instanceDescription` and the 512px app icon. An invite card says "Join the <server> server on <instance>", uses the server description or a sentence with the member count, and shows the server icon at 256px when the server has one. A group DM invite gets a generic group DM card. An unknown or expired invite gets the homepage card, so the page doesn't reveal whether a code ever existed.

`/api/v9/oembed?url=<page>` answers oEmbed requests for pages on the same host with the same title, provider and thumbnail. It returns 404 for any other host. The pages link to it with `<link rel="alternate" type="application/json+oembed">`.

Inside the client, a link to an invite on the same instance renders Discord's invite card. A link to another Meowcord instance is unfurled from these tags like any other site when `externalRequests.thirdParty` is on, so it shows the instance name, the description and the icon.
