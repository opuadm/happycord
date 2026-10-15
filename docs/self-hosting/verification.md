# Getting verified

As an admin of a verified instance, you can approve servers to get into the global discovery, and your instance can federate with any other verified instance.

To make sure this doesn't get abused, we manually verify every instance that opts in to federation. However, we don't manually verify servers that you approve before them getting into the global discovery.

## Pre-verification checklist

Before submitting for verification, make sure all of these have been done:

- You are running an up-to-date Meowcord instance with federation on over HTTPs, and haven't disabled sign-up CAPTCHAs, pride flags or put anything behind a paywall.

- Your instance must be actively moderated, and you must be able to be reached by the main project's moderators. Please specify your Discord username on your PR.

- Your instance **must** have a publicly accessible Terms of Service which explicitly bans the following:

  - Sexual content, including pornography, sexually explicit material, and sexualized imagery. This includes non-consensual intimate media, such as sharing or threatening to share private sexual images, including AI-generated or deepfake ones.
  - Harassment, doxxing, threats and violence, including incitement to violence, glorifying violent attacks, or promoting terrorist or violent extremist groups.
  - Hateful conduct, including attacking or demeaning people based on race, ethnicity, nationality, religion, sex, gender identity, sexual orientation, disability, or age. This includes racial slurs, misgendering, and deadnaming.
  - Self-harm promotion, including encouraging or instructing suicide, self-harm, or eating disorders. Supportive and recovery discussion is fine.
  - Spam, scams and manipulation, including unsolicited advertising, repetitive posting, automated or bot activity, fake engagement, vote or metric manipulation, phishing, fake giveaways, pyramid schemes, and deceptive financial offers.
  - Impersonation, including pretending to be another person, brand, or organization in a misleading way.
  - Anything illegal under Portuguese law or applicable EU law.
  - Creating new accounts or otherwise circumventing bans, suspensions, or these rules.
  
  Not enforcing any of these properly may result in a permanent or temporary ban from verification.

* We may still deny any verification requests regardless of the rules above, or remove verified instances at any time for any reason.

## Submitting your request

If you meet all of the above requirements, you're eligible to ask for approval!

You should now open a pull request. Add your instance to `instances.json` at the repository root with `id`, `name`, `url` and `source_url`, run `bun scripts/instances-md.mjs` to regenerate `instances.md`, and open a pull request with both files.

Once you get approved, your instance will be added to the registry and should propagate to every other verified instance within a few minutes. This may take up to an hour.

## Keeping it approved

- **Keep `federation.key`.** It sits next to `jwt.key` in the working directory, or in the `state` volume under Docker. Back both up. When an approved instance starts serving a different key, the registry keeps publishing the old key, marks the instance "new key waiting" and ignores its discovery list until we confirm the change with you. Tell us in an issue when you rotate the key on purpose. This stops someone who takes over your domain from speaking for your instance.
- **Keep updating.** An old version can miss protocol changes and stop federating.
- **Keep your admin contacts current.** Every announce sends the registry up to 10 handles such as `meow@meow.example` for your admins. By default these are the accounts with the operator right. The registry admins see them privately, on your instance's entry in the registry dashboard, and can add them to a "Meowcord Admins" group DM with the admins of every approved instance. The handles are never published in the registry document. To send other accounts, list their local usernames, one per line, under Registry contacts in the admin dashboard's Federation page, or set `federation.contacts` in the config. With announcing on, saving the list announces again 30 seconds later, and the Announce card shows which handles go out. An account that leaves the group DM can be added back the next time the registry admins open it.
- **Decide whether to share counts.** Every announce also sends how many local users and servers your instance has and how many messages its users sent in the last 24 hours. The registry admins see these numbers on their dashboard and never publish them. To stop sending them, turn off "Send user, server and message counts with each announce" in the admin dashboard's Federation page, or set `federation.announceStats` to false.
- **Answer reports.** We suspend an instance whose admins don't act on reports about it. A suspended instance stays in the document but other instances stop federating with it until we approve it again.

## Getting a server verified

If you operate an instance and would like a server in it to be shown to listed to all other instances in discovery, here's what you should do:

1. The owner opens Server Settings, Other instances, and turns on Show on other instances. The server gets a permanent invite if it has none, and people from other instances can join through that invite right away.
2. The server shows "waiting for this instance's admins" in that section.
3. An admin of the instance opens the admin dashboard, Federation, and presses Verify next to the server. The server goes into the instance's signed discovery list at `/.well-known/meowcord/discovery`.
4. 30 seconds after the last Verify or Take back, the instance announces itself to the registry, the registry fetches the new list and publishes a new document right away. Other instances show it under Other instances from their next registry fetch, which happens every 5 minutes. With `federation.announce` off, the registry only sees the change at its own rotating check, which reaches each instance every few hours, or when an admin presses Send to registry.

The owner sees "waiting for the registry" between steps 3 and 4 and "listed" after.

### What instance admins should check

Verifying a server puts your instance's name behind it. Before you press Verify, look at the server the way someone from another instance will see it:

- The name, icon and description match what the server is.
- The server has rules, and moderators who enforce them.
- AutoMod and raid protection are set up, or the server is small enough that its moderators keep up by hand.
- The content is fine to show anyone who opens Discover on any instance.

Press Take back to unverify a server. It leaves your discovery list right away, your instance announces 30 seconds later, and the registry publishes a document without it. Turning the switch off as the owner has the same effect.

By default an instance shows every server the registry lists. Set `federation.discovery.verification` to `instance` to also verify servers from other instances yourself before your users see them. The Federation page then lists them with the same Verify and Take back buttons.