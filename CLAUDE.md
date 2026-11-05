# CLAUDE.md

Project rules for coding assistants and contributors. Read
`~/code/integrations/CLAUDE.md` and `_lots/fiche.md` first when working from
the integrations workspace.

## What this is

A Gladys Assistant external integration (Node.js 22+, ESM, no build step, one
runtime dependency: `@gladysassistant/integration-sdk`) for Becker covers and
sensors through the CentralControl CC31/CC41/CC51, over its local JSON-RPC API.

## Commands

```bash
npm install
npm test                 # node --test --test-timeout=60000 (every test/*.test.js)
npm run lint
npm run format:check
npm run cover
```

From the integrations workspace: `gi test`, `gi ci`.

## Architecture

```
index.js            SDK wiring; app.boot() sends the stops of /data at once
src/handlers.js     the SDK handlers (shared with the tests)
src/app.js          lifecycle, reads, commands, the stop and close paths
src/rpc.js          HTTP POST + JSON-RPC of the box (bounded, beforeSend)
src/model.js        items and states of the box -> Gladys devices (pure)
src/config.js       configuration (address, interval, language)
src/store.js        /data (bounded, special files refused)
src/i18n.js         every text shown, en/fr
src/constants.js    keys, API vocabulary, limits, timings
test/helpers/       fake box (in memory), virtual clock, app setup
```

## Rules

- External ids are forever: `ext:becker:group:<id>`, `ext:becker:remote:<id>`,
  feature keys `state`, `position`, `sun`, `wind`, `rain`, `dawn`, `temp`.
- The stop is never blocked (see docs/en.md "The stop"); every change near it
  needs a test that fails without it (`test/stop.test.js`), on the virtual
  clock, never a wait without bound.
- Decisions on the monotonic clock; the wall clock only through the session
  clock, for /data.
- Never the Becker relay headers, never a cookie, never the cloud.
- Changelog under `## [Unreleased]`; user texts in English and French; docs and
  i18n kept true to the code.
