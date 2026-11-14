# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- The hourly AESO pool price, read from the official API with the user's free
  key (`API-KEY` header, never logged nor kept in /data), every hour 5 minutes
  after its end, the last 35 days at the first start (further back for a
  contract starting earlier, 400 days at most).
- The `spot-ca-ab` energy calendar (CAD/kWh, 30-minute slots,
  America/Edmonton) and the "AESO pool price (floating rate)" contract
  template (rules mode): pool price plus retailer adder, delivery per kWh,
  fixed charges per month, GST, and a provisional price typed by the user for
  the hours not settled yet, replaced by the real price once published.
- A refused key (401) stops every automatic request, across restarts, until the
  key changes or the "Test the key" button succeeds; a 403 is never taken for a
  refused key; 429 and quota pauses kept in /data.
- An answer whose hours do not read while an expected hour lacks is an error
  (not connected, growing back-off), never a quiet success.
- The calendar is read back from Gladys at each connection, from its last
  entry: days lost at its end (a database restored) are sent again, the days
  the core purges never.
- A late hour is asked again 10, 20, 40 minutes later, then hourly; no new
  price for 3 hours is said in the status (not connected).
- One unreadable settled hour waits a day (said in the status) without slowing
  the other hours.
- `countries: ["CA"]` in the manifest (Gladys 5.3.0 or later).
