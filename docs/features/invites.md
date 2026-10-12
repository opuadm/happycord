# Instance invites

An instance invite is a code that lets someone create an account. It is separate from server invites, which add an existing account to a server. Turning on invite-only registration makes every new account need a working instance invite, and the server records who invited whom, so staff can follow an invite tree and remove a whole branch of spam accounts at once.

## Turning it on

Site settings has Make the instance invite-only under Registration, which sets `register.requireInvite`. While it is on, `POST /api/v9/auth/register` refuses a signup without a code with `INVITE_ONLY`, and one with a revoked, expired, used up or unknown code with `INVALID_INVITE`. Both errors are field errors on `username` and `instance_invite`, so the stock signup form shows them under the username. Server invites no longer count as an invite for registration. A registration token from `ValidRegistrationToken` still skips the check, the same as it skips the other registration limits.

Registration claims a use of the invite with a single conditional `UPDATE`, so two people can't both take the last use. If creating the account fails after the claim, the server gives the use back. An invite stops working once its creator's account is disabled or deleted.

With invite-only off, a valid code still records who brought the person in, and an invalid one is ignored.

## Invite links

The link has the form `https://<instance>/register?instance_invite=<code>`. The FosscordInvites plugin in `client/plugins/fosscordInvites` reads the code when the page loads, keeps it in `sessionStorage` under `fosscordInstanceInvite` and adds an Invite code field above the consent line of the stock signup form. The field is shown when the instance is invite-only or the link carries a code. It checks the code with `GET /api/v9/auth/instance-invite?code=<code>` and shows who sent the invite, or that the code doesn't work. The plugin adds `instance_invite` to the registration request body. The lookup route needs no sign-in and allows 30 requests per IP per minute.

## Invites for members

Members make their own invites in User Settings, under Invites below Data & Privacy. The page shows how many people they can still bring in, a form to create a link with a number of uses and an expiry, their links with Copy link and Revoke, and the people who joined through them. Creating a link copies it.

Each member's total is the instance default plus any extra invites staff gave them. The default applies once the account is old enough. Every person who joined with one of their invites uses one, and the unused uses of their working invites are held back, so a member with 3 invites can make one link for 3 people or 3 links for one each. Revoking an unused link gives its uses back. Staff invites never count against anyone. Bots can't make instance invites.

| Key                                            | Default | Meaning                                                                             |
| ---------------------------------------------- | ------: | ----------------------------------------------------------------------------------- |
| `register.instanceInvites.perUser`             |       3 | Invites each member gets                                                            |
| `register.instanceInvites.minAccountAgeDays`   |       7 | Days an account has to exist before it gets the default. Extra invites apply at once |
| `register.instanceInvites.maxUsesPerInvite`    |       3 | Most people one member link can let in                                              |
| `register.instanceInvites.maxAgeDays`          |      30 | Longest a member link can last. 0 allows links that never expire                     |

Site settings shows the same 4 fields under Registration. Member links last between 1 hour and `maxAgeDays`.

| Method and path                                | What it does                                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| `GET /api/v9/users/@me/instance-invites`       | Your quota, the limits for a new link, your links and the people who joined with them |
| `POST /api/v9/users/@me/instance-invites`      | Create a link from `{ max_uses, max_age_seconds }`                                    |
| `DELETE /api/v9/users/@me/instance-invites/<code>` | Revoke one of your links                                                          |

These share the `users/@me/instance-invites` rate limit bucket from `limits.rate.routes.instanceInvite`: 10 writes and 60 reads per user per minute by default.

## Admin dashboard

Instance invites under People & servers lists every invite with its creator, uses, expiry and state, filtered by state or searched by exact code or note text. Create invite makes a staff invite with any number of uses, 0 for no limit, an expiry up to a year or none, and a note only staff see. Opening an invite shows its link, who made it, everyone who joined with it, how many accounts sit below it in the invite tree and a revoke form. The revoke form can also disable the accounts that joined with the invite, or everyone below it in the tree.

The user drawer has an Invites card with who invited the account and the chain of inviters above it, the invites it has left, an Extra invites field, the tree of accounts it brought in, its invite links and Disable everyone they brought in, which can include the account itself.

Disabling a branch sets `disabled` on each account, revokes their working invites, ends their sessions and signs out their open clients. It skips accounts with `OPERATOR`, `MANAGE_USERS` or `MANAGE_GUILDS` and the staff member doing it. Branches are followed 32 levels deep and up to 10,000 accounts, and the tree in the drawer shows the first 500 accounts down to 8 levels.

| Method and path                                              | What it does                                                         |
| ------------------------------------------------------------ | -------------------------------------------------------------------- |
| `GET /api/v9/admin/instance-invites`                         | List invites, with `state`, `q`, `creator_id`, `offset` and `limit`  |
| `POST /api/v9/admin/instance-invites`                        | Create a staff invite from `{ max_uses, max_age_seconds, note }`     |
| `GET /api/v9/admin/instance-invites/<code>`                  | One invite with the accounts that joined and the branch size         |
| `POST /api/v9/admin/instance-invites/<code>/revoke`          | Revoke, with `disable` set to `none`, `joined` or `branch`           |
| `GET /api/v9/admin/users/<id>/invites`                       | Who invited the account, its quota, links and the tree below it      |
| `PATCH /api/v9/admin/users/<id>/invites`                     | Set `bonus_invites`, from -1000 to 10000                             |
| `POST /api/v9/admin/users/<id>/invites/disable-branch`       | Disable everyone below the account, with `include_user` for itself   |

All admin routes need `MANAGE_USERS`.

## Storage

`instance_invites` holds each code with its creator, whether staff made it, the note, the use limit and count, and when it was created, expires and was revoked. `instance_invite_users` holds one row per account that joined with an invite, with the code and the inviter, plus the extra invites staff gave that account. Migration `1792201734519-InstanceInvites` creates both tables for PostgreSQL and SQLite. Deleting an account deletes its row, and its invites and the rows of the people it invited keep their history with the creator or inviter set to null.

## Tests

`scripts/tests/instance-invites.test.cjs` covers invite states, the quota, config fallbacks, the limits on new links, claiming and disabling a branch.
