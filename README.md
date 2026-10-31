# Testbot

Testbot is a test harness for checking how this Discord.js bot behaves when it is connected to Discord and Veiled at the same time. It keeps the existing bot commands and event handlers in place and adds an optional Veiled runtime for migration testing.

This repository is a test project, not the Veiled.js SDK and not a promise that every Discord.js feature has a Veiled equivalent. The compatibility work is still being validated. Passing the offline tests does not prove that a command works against live services.

## What is here

- The original bot command and event modules.
- An opt-in Veiled runtime and the Discord.js-shaped objects it provides to selected handlers.
- Checks for platform identity separation, command registration safety, event dispatch, and voice adapter behavior.
- A small live smoke test for confirming the two test bot identities and sending then deleting a harmless message on each platform.

The Veiled runtime is disabled by default. Discord global command registration is also disabled by default, so starting this project does not overwrite the bot's global commands unless you explicitly turn that on.

## Requirements

- Node.js 18.12 or newer
- npm
- PowerShell for the live smoke script

Some bot features also need MongoDB or external services such as Lavalink. Those are not needed for the offline migration tests.

## Local setup

```powershell
npm ci
Copy-Item .env.example .env
```

Edit `.env` on your machine. Add only the credentials and services needed for the commands you are testing. Keep these settings off unless you are deliberately testing command registration:

```env
SYNC_DISCORD_GLOBAL_COMMANDS=false
VEILED_RUNTIME_REGISTER_COMMANDS=false
```

The Veiled compatibility runtime also stays off unless `VEILED_RUNTIME_ENABLED=true` is set. When enabling it, use a dedicated Veiled test bot, set `VEILED_RUNTIME_ROOM_ID` to the test room, and configure an installed Veiled bot SDK through `VEILED_SDK_PATH` or `VEILED_SDK_PACKAGE`.

Do not use production bot credentials or production rooms for migration tests. Do not commit `.env`, tokens, database files, logs, or local service data.

## Run the offline checks

```powershell
npm test
```

The tests do not log in to either platform. SDK-backed checks are skipped when the SDK build is not available in the local environment; a skipped check is not a passing live acceptance test.

## Run the live smoke check

```powershell
npm run migration:live
```

The script asks for the Discord and Veiled test bot tokens with masked prompts. It first checks the bot identities and configured test targets, then posts one harmless message on each platform and deletes those messages. Review `scripts/run-migration-smoke.ps1` before running it and make sure its test server, channel, room, and lane are the locations you intend to use. The smoke check does not exercise the full command set.

## Running the full bot

`npm start` uses the bot's regular startup path. That path can connect to MongoDB, Lavalink, and other configured services. Use it only when those dependencies and credentials are ready, and keep the Discord and Veiled bot tokens separate. For a focused connectivity check, use the migration smoke command above instead.

## Current limits

The runtime and tests cover selected commands, event handlers, interactions, and voice behavior. They do not establish complete Discord.js parity. Before relying on any command in Veiled, check whether its APIs and permissions are supported and test its effects in the designated test room. Keep platform writes isolated and verify failures as well as successful responses.

## Credits and license

This test project is based on the [ALL-IN-ONE Discord Bot](https://github.com/Uo1428/ALL-IN-ONE-Discord-Bot-) by Uo1428, with its existing credits and license retained in this repository. The Veiled migration test code is maintained alongside that source for compatibility work.
