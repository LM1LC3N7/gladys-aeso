# AESO pool price for Gladys Assistant

**Unofficial**, not affiliated with the AESO (Alberta Electric System Operator).
Never tested with a real AESO key nor a real Gladys contract yet: the answer
format comes from the official OpenAPI description of the AESO developer portal
(read on 2026-11-14, when the gateway answered 401 without a key, as
documented); the test answers are made-up prices.

A Gladys Assistant external integration for Alberta households on a
**floating (variable) retail rate** that follows the hourly **pool price**:

- it reads the pool price of every settled hour from the official AESO API,
  `https://apimgw.aeso.ca/public/poolprice-api/v1.1/price/poolPrice`, with your
  own free API key (`API-KEY` header);
- it feeds the Gladys energy calendar `spot-ca-ab` (CAD/kWh, 30-minute slots,
  America/Edmonton);
- it offers the contract template **"AESO pool price (floating rate)"**: the
  pool price plus your retailer adder, the delivery charges per kWh, fixed
  charges per month and GST, priced by the Gladys rule engine.

The pool price of an hour is known only once the hour has ended. Until the
integration publishes it, Gladys counts the **provisional price** you type in
the contract, then recomputes the cost with the real price (a few minutes to an
hour later; later if the integration was stopped). The current price shown by
the dashboard is that provisional price.

The pool prices are the AESO's data: personal, non-commercial use only, under
the terms you accept when subscribing to the API product
(<https://www.aeso.ca/legal>); never share the key nor the prices.

Guides: [English](docs/en.md) · [Français](docs/fr.md).

## Development

```bash
npm install
npm test                 # node --test, virtual clock and a scripted API
npm run lint && npm run format:check
node scripts/mutants.mjs # mutation check of the guards (use memcap)
```

Requires Gladys 5.3.0 or later (energy contracts, `countries`). Licence: Apache-2.0
(`LICENSE`); notices in `THIRD_PARTY_NOTICES.md`.
