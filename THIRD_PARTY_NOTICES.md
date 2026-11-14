# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). Its
code is its own: no third-party code is copied or ported.

## AESO Pool Price Report API (data)

At run time the integration reads the Pool Price Report of the AESO public API,
version 1.1: `https://apimgw.aeso.ca/public/poolprice-api/v1.1/price/poolPrice`,
with the API key each user gets from the AESO developer portal
(`https://developer-apim.aeso.ca/`). Using the portal and the key means
accepting the AESO terms of use, which each user does when signing up; the AESO
data remains the AESO's. The integration only reads the settled hours about
once an hour, keeps them in its `/data` volume and never ships them in this
repository nor in the Docker image (the test fixtures are made-up prices).
"AESO" and "Alberta Electric System Operator" are names of the AESO, used here
only to say which data is read.

Changes made to the data: the price per MWh is divided by 1,000 (per kWh); each
hour is written as two 30-minute slots of the same price; an hour that does not
read is left unknown. The forecast pool price is never read.

## Reference read, not copied

- `aeso-python-api` by Guanjie Shen (MIT License,
  https://github.com/guanjieshen/aeso-python-api, December 2025) was read as an
  example of the endpoint, the `API-KEY` header and the `return` envelope. No
  code was copied or ported.

## Runtime dependency

- `@gladysassistant/integration-sdk` (Apache-2.0), the Gladys SDK.
