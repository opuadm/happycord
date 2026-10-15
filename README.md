<p align="center">
  <img width="100" src="assets/icon.png" />
</p>
<h1 align="center">Happycord</h1>

**happycord is a self-hosted discord clone with feature parity and message encryption.** it serves a custom patched Discord web client with Equicord from a local copy and rebrands that client as your instance. the default instance name is Happycord, and custom names come from the instance configuration. anyone can sign up on your instance, log in with the real Discord UI and use it the way they use Discord, without a Discord account.

**happycord is currently in very early alpha.** right now, it's a big mess and not recommended for production use or anything other than testing. during this alpha, we'll also have an extremely permissive ai contribution policy, so that we can get as many people as possible to test it and contribute to it. else, we'd never get anywhere near discord feature parity.

## join meowcord!!

since meowcord is federated, no matter what instance you pick, you'll always be able to talk to anybody else, even on other instances :3

**start by [picking an instance from this list](instances.md) and signing up.** you can find servers to join in the Discovery tab.

## self-hosting

follow [the setup guide](docs/self-hosting/setup.md) for Docker, local development and the source archive. to run without Docker, [the native Linux guide](docs/self-hosting/native.md) sets the server up as a dedicated `meowcord` user with systemd, local PostgreSQL and an HTTPS reverse proxy, and covers voice, operator access, backups and updates. the server supports [PostgreSQL and SQLite](docs/self-hosting/databases.md).

for Docker, copy `.env.example` to `.env`, set your instance domain, PostgreSQL password and public voice address, then run:

```sh
docker compose up -d --build
```

after registering your operator account, grant it access locally using its numeric account ID: `docker compose exec server bun scripts/ops/operator.mjs grant <account-id>`. the first signup is an ordinary account. see the alpha guide for local provisioning and revocation.

to get your instance listed in [instances.md](instances.md) and in global discovery, read [the verification guide](docs/self-hosting/verification.md).

## contributing

AI contributions are allowed during the alpha. please read [CONTRIBUTING.MD](CONTRIBUTING.MD) for development conventions and verification commands, and open an issue or pull request for bugs and improvements.

## License

AGPL-3.0-only, see [LICENSE](LICENSE). Code inherited from before this fork is by [Spacebar](https://github.com/spacebarchat/server) and its contributors.
