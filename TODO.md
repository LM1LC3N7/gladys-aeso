# TODO

## Before announcing

- [ ] Review r1 (xhigh: energy contract, cloud API with a key).
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic at publication only.
- [ ] Store field not set in the manifest: `keywords` (Alberta, AESO, pool
      price, floating rate, spot, électricité).

## To watch

- [ ] Never tried with a real AESO key: the gateway, the endpoint and the
      `API-KEY` header answered as documented on 2026-11-14 (401 without a
      key); the answer layout comes from the portal's OpenAPI and two MIT
      clients (aeso-python-api, gridstatus). Check the first real answers
      (`return` envelope, `begin_datetime_mpt` after the 2026 time change,
      inclusive `endDate`).
- [ ] The AESO publishes no call quota for the public product: about 24
      requests a day here. A 403 "Out of call volume quota" pauses.
- [ ] Never tried with a real Gladys contract: the template is checked by the
      core validator and its rule engine (test/manifest.test.js) only.
- [ ] Alberta's permanent UTC-6 (tz 2026c; by law since 2026-06-18, no
      fall-back on 2026-11-01): if the province or the AESO change the
      settlement clock again, the MPT check refuses the rows, which the status
      shows as an unreadable answer (not connected, growing back-off). Keep `node:24-alpine` current.
- [ ] Restructured Energy Market (REM): a new price cap, floor or settlement
      interval would need a review of MIN/MAX_PRICE_MWH and of the hourly
      model (the calendar key keeps its 30-minute granularity for ever).
- [ ] Corrections of a complete day are not read again (rare at the AESO).

## Decisions

- Version 0.1.0 set by hand (package.json, lock, manifest, docker_image).
- `gladys_version: ">=5.3.0"`: `countries: ["CA"]` (Louis, 2026-11-12) needs
  5.3.0; `energy_contracts` needs 5.2.0.
- **Rules mode, not delegated.** The pool price of an hour exists only once
  the hour has ended, and the core prices the last 30 minutes at :00 and :30:
  a delegated request always holds an interval whose hour is not settled, and
  fails whole (one cost per interval or none), so it would never be priced.
  The rule engine counts the component `fallback` instead, a **provisional
  price the user must type** (required input, no default: never written by the module, never a
  guess of the module), and recomputes the costs when the calendar entry
  arrives (`changed_from`). Said in the template, the docs and the intro.
- Calendar `spot-ca-ab` (no provider prefix), `thirty_minutes` (the pool
  price is hourly; the core meters are 30-minute), CAD/kWh, America/Edmonton.
  A key owned by another integration: said in the status, nothing else.
- Only the settled pool price is read, never the forecast; the current hour
  and an hour not ended are never taken even with a price.
- 401 = refused key (the only endpoint, so never a secondary route); a 403 is
  never a refusal (a quota pauses, anything else backs off). The refused key
  is known exactly in memory and by 8 salted bits in /data; a changed key is
  always tried, the button tries once and lifts the refusal on success.
- `startDate`/`endDate` are Mountain days, both included (gridstatus test:
  4 days asked, 96 hours); `endDate` must follow `startDate`, so a single day
  is asked without it.
- The tz database must know the 2026 change (`TZ_CURRENT`): otherwise nothing
  is asked (every winter hour would be an hour off).
- An answer where no hour reads while hours are expected = an `invalid`
  failure (status not connected, back-off): a changed format or clock is
  visible (review r1). A single unreadable settled hour only waits a day
  (status warning), the hourly rhythm goes on; a non-numeric price within the
  hour after its end is "not settled yet" (review r2).
- The calendar is read back at each connection from the day of the last entry
  Gladys holds (`limit: 1`, then 20 days a call): the end lost by a restore is
  sent again, the beginning purged by the core every night never (review r2).
- The placeholder of a just-ended hour ("" or "-") is a guess from gridstatus
  and the ETS report: check it on the first real answers.
- No device and no scene trigger in 0.1.0 (the price goes through the
  contract); `type: provider`.
- `.github/workflows/ci.yml`: `timeout-minutes: 30` on both jobs (taken from
  the other modules), so a release tag must be pushed by hand once.
