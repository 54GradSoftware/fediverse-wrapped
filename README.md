# Fediverse Wrapped

A fediverse bot that replies to a mention with your year in review: shareable
images built from your public posts of the last 365 days.

- DE `@fediwrapped_de@wrapped.fedw.eu`
- EN `@fediwrapped_en@wrapped.fedw.eu`

It reads plain ActivityPub, not the Mastodon API, so it works with Mastodon,
Misskey, Sharkey, Pleroma, Akkoma, Friendica, Hollo and many more.

## How it works

1. Mention the bot, publicly or in a DM. Add `tz=Europe/Vienna` for your timezone if you want.
2. It reads your **public** outbox and renders up to eight tiles.
3. It replies exactly as publicly or privately as you mentioned it.

You can only get a wrapped for your own account, one per day. If the bot cannot read your whole year, the reply and the tiles say the numbers are a lower bound.

## Privacy

- Only generates wrapped for the account mentioning the bot.
- Never reads followers only posts, and fetches unsigned first.
- Never follows anyone, and only analyses the account that mentioned it.
- Never names other accounts on the images.
- Links at most one post: the user's own public top post, never an unlisted post or a reply.
- Posts are never stored. Details in [PRIVACY.md](PRIVACY.md).

## Compatibility

Tested against 35 implementations. Does **not** work with Pixelfed, Loops,
GoToSocial, Lemmy, PieFed, the WordPress plugin, Micro.blog and Bridgy Fed,
because they publish no readable outbox. The bot tells those users why.

## Possible next features

- **Moved accounts.** Today the bot only reads the account that mentioned it. Your new account lists the old one in `alsoKnownAs`, and the old
  account points back with `movedTo`.

## Development

Node ≥ 24 runs the TypeScript directly; there is no build step.

```sh
npm install
cp .env.example .env          # set ORIGIN and ACTOR_SALT
npx @fedify/cli tunnel 8000   # public test domain
npm start
npm test && npm run typecheck && npm run lint
```

`TESTING_MODE=true` runs a closed beta: the bot only answers DMs from accounts
the operator added with `node ace follow @user@host`, accepted or still pending.

## Deployment

Docker Compose on Coolify, both bots in one container. Production runs at
`https://wrapped.fedw.eu`. All variables are explained in `.env.example`.

> ⚠️ `ORIGIN`, `BOT_DE_HANDLE` and `BOT_EN_HANDLE` can never change after the first
> federation, and the `wrapped-data` volume (keys and followers) must be backed
> up off the host. There is no migration path.

## How this was built

The bot is built on [BotKit](https://botkit.fedify.dev/), a framework for
standalone ActivityPub bots. BotKit is made by the Fedify team and runs on
[Fedify](https://fedify.dev/), which handles federation, signatures and
WebFinger. The code was written with 
Assited-By: Claude Code Opus 5.5. All of it was planned, reviewed
and tested by humans, feel free to say Moin!

## License

`AGPL-3.0-only`, see [LICENSE](LICENSE). Font: [Inter](https://rsms.me/inter/),
SIL Open Font License.

All our fediverse tools and projects are collected on [fedw.eu](https://fedw.eu/de/).
By [54 Grad Software GmbH](https://www.54gradsoftware.de/) ·
kontakt@54gradsoftware.de ·
[@54gradsoftware@norden.social](https://norden.social/@54gradsoftware)
