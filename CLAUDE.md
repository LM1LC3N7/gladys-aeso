# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** of type `provider` (Node.js 22+,
ESM, no build step, sandboxed Docker container, `@gladysassistant/integration-sdk`
0.16). It reads the hourly **AESO pool price** (Alberta) with the user's free
API key, feeds the energy calendar `spot-ca-ab` (CAD/kWh, 30-minute slots) and
declares the rules-mode contract template "aeso-pool-price" (pool price + adder,
delivery, fixed, GST, a provisional price for the hours not settled yet).
Unofficial. Read-only.

## Commands

```bash
npm install
npm test                                  # node --test (or gi test)
npm run lint && npm run format:check
memcap node scripts/mutants.mjs           # mutation check, one mutant at a time
```

## Architecture

```
index.js          SDK wiring only (src/handlers.js)
src/app.js        App: lifecycle, config, /data, schedule, requests, refused key,
                  pauses, calendar, status, the "Test the key" button
src/data.js       strict reading of the Pool Price Report and of /data (pure)
src/config.js     the key normalized, the salted 8-bit tag of a refused key
src/time.js       America/Edmonton days, TZ_CURRENT (pure)
src/http.js       the only network access (key header, User-Agent, bounds, 401/403/429)
src/store.js      /data state file (missing vs unreadable, atomic write, 0600)
src/i18n.js       status and button texts (en, fr)
src/constants.js  manifest keys, bounds, schedule
```

## Module rules

- **Never more than the source changes**: one request an hour (5 minutes after
  the end of the hour), 10, 20, 40 minutes later, then hourly, while the hour is late; never
  sooner than a minute after the last request, restart included.
- **Never guess a price**: an empty, unreadable or unsettled hour stays
  unknown; the forecast is never read; the core counts the provisional price
  the user typed.
- **The key**: never in a URL, a log, a status, /data or an error; 401 only is
  a refusal; a 403 never.
- **Keys are forever**: template key, input keys, calendar key and
  granularity, action key, config key.
- Bilingual texts (en/fr), CHANGELOG `[Unreleased]`, versions by the Release
  workflow only.

## Rules

- **External ids are forever.** Build them with
  `gladys.externalIds(type, platformId)`, `platformId` being the unique id the
  platform gives the device (serial, cloud id, MAC), never a label. Gladys keys
  devices, their history, scenes and dashboards on them: changing one creates a
  new device and orphans the old one. The same goes for every key users store:
  manifest `config_schema`, `actions`, widget and scene keys, feature keys.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume. Never log tokens, passwords or API keys.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand — except for a hand-pushed release tag, which bumps all three together
  before tagging (0.1.0 was set that way when leaving the template). `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language. A field the
  older cores do not know needs a higher `gladys_version` minimum
  (`categories`: 4.86.0; `widgets`, `scene_triggers`, `scene_actions`,
  `type: "provider"`: 5.1.0). `test/manifest.test.js` ties the manifest to the
  code (defaults, action, scene and widget handlers): change both sides
  together.
- **User-facing text** is bilingual (English and French): action messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.
