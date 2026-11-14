// -----------------------------------------------------------------------------
// The integration: keeps the AESO pool prices per local day (Mountain time) in
// memory and in /data, asks the AESO Pool Price Report only for the settled
// hours it lacks, and feeds the `spot-ca-ab` energy calendar (30-minute slots,
// CAD/kWh) that the "AESO pool price" contract template reads. The core prices
// the contracts (rules mode): the integration answers no pricing request.
//
// When the API is asked: at the first start, the last 35 days (further back
// when a contract on the template starts earlier, a year and a month at
// most); then every hour, 5 minutes after the end of the hour (the pool price
// of an hour is known once it has ended), the day of that hour; again every
// 10 minutes while the expected hour is missing; a past day answered
// incomplete once a day. Nothing else: a complete day is never asked again; a
// restart, a reconnection or a new configuration never asks sooner than a
// minute after the last request (the time of the attempt is in /data first).
//
// Clocks: the gaps, back-offs and pauses run on the monotonic clock
// (`monotonic`), whose time since the last attempt is rebuilt from /data at a
// restart and capped; the wall clock (`now`) gives the local day and hour and
// dates /data. Timers never sleep more than an hour, so a wall clock that jumps
// is caught up.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import {
  API_URL,
  BACKFILL_DAYS,
  CALENDAR,
  CALENDAR_BATCH,
  CALENDAR_READ_DAYS,
  CALENDAR_TIMEOUT,
  CONFIG_RETRY,
  CONFIG_RETRY_MAX,
  CONTRACTS_EVERY,
  CURRENCY,
  EMPTY_RETRY,
  KEEP_DAYS,
  MAX_ANSWER_BYTES,
  MAX_CONTRACTS,
  MAX_DAYS_PER_REQUEST,
  MAX_RETRY,
  MAX_SLEEP,
  MIN_GAP,
  PAUSE_DEFAULT,
  PAUSE_MAX,
  PAUSE_MIN,
  PUBLISH_DELAY,
  RETIRED_RETRY,
  RETRY_STEPS,
  SAVE_TIMEOUT,
  STATUS_TIMEOUT,
  STORE_RETRY,
  TEMPLATE,
  WAIT_PUBLICATION,
} from './constants.js';
import { normalizeConfig, tagOf, validRefused } from './config.js';
import { DataError, dayRecord, parseAnswer, perKwh, restoreDay, sameDay } from './data.js';
import { SourceError, getJson } from './http.js';
import { REASON_CODES, T } from './i18n.js';
import {
  DAY_PATTERN,
  HALF_HOUR,
  TZ_CURRENT,
  HOUR,
  addDays,
  dayOf,
  dayStart,
  daysBetween,
  hoursOf,
} from './time.js';

const realTimers = { setTimeout, clearTimeout };

/** A wall date read from /data: a finite number not in the future, else undefined. */
const pastDate = (value, now) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= now
    ? value
    : undefined;

/** A short fingerprint of what the calendar received for a day (prices only). */
const signature = (values) =>
  createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 16);

/** The start of the last hour whose pool price should be published at `now`. */
export const lastExpected = (now) => Math.floor((now - PUBLISH_DELAY) / HOUR) * HOUR - HOUR;

/** When the next hour is expected: 5 minutes after the end of the current one. */
const nextPublication = (now) =>
  Math.floor((now - PUBLISH_DELAY) / HOUR) * HOUR + HOUR + PUBLISH_DELAY;

/** The automatic check asks at most this many date ranges (31 days each) in a row. */
const RUNS_PER_CHECK = 3;

export class App {
  constructor({
    gladys,
    logger = console,
    now = Date.now,
    monotonic = () => performance.now(),
    timers = realTimers,
    store,
    fetchImpl = (...args) => globalThis.fetch(...args),
    random = randomBytes,
    tzCurrent = TZ_CURRENT,
  }) {
    /** The tz database knows Alberta's permanent UTC-6 (2026c or later). */
    this.tzCurrent = tzCurrent;
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.random = random;
    /** local day -> { start, prices: [CAD/MWh | null], known } */
    this.days = new Map();
    /** local day -> wall time of the last answer that left it incomplete */
    this.incomplete = new Map();
    /** day -> signature of what the calendar received. */
    this.sent = {};
    /** Why the calendar is not fed: 'refused' (403), 'error', or undefined. */
    this.calendarIssue = undefined;
    this.meta = { attemptAt: undefined, checkedAt: undefined, failures: 0 };
    /** Monotonic time of the last request (rebuilt from attemptAt at a restart). */
    this.attemptMono = undefined;
    /** `{ until (wall), due (mono), code }` after a 429 or a quota. */
    this.pause = undefined;
    /** Hour start -> wall time until which an hour the AESO answered unreadable waits. */
    this.unreadable = new Map();
    /** `{ salt, tag }` of the refused key (/data), and the key itself (memory only). */
    this.refused = undefined;
    this.refusedKey = undefined;
    this.lastError = undefined;
    this.retryAt = undefined;
    /** `{ key, problem }` once read from Gladys. */
    this.config = undefined;
    this.pendingConfig = undefined;
    this.configTimer = undefined;
    this.configFailures = 0;
    this.configRetryAt = undefined;
    this.contracts = undefined;
    this.earliest = undefined;
    this.contractsMono = undefined;
    this.loaded = false;
    this.loading = undefined;
    this.timer = undefined;
    this.storeTimer = undefined;
    this.checking = undefined;
    this.publishing = undefined;
    this.running = false;
    this.generation = 0;
    this.lastStatus = undefined;
    this.statusJob = Promise.resolve();
    this.saving = undefined;
    /** Why the last write of /data failed ('write', 'timeout'), undefined when it worked. */
    this.dataError = undefined;
  }

  // --- Lifecycle -------------------------------------------------------------------

  /** Every connection: /data once, the configuration read again, the status republished. */
  async connected() {
    this.running = true;
    this.generation += 1;
    const gen = this.generation;
    this.lastStatus = undefined;
    await this.loading?.catch(() => {});
    if (gen !== this.generation) return;
    if (!this.loaded) {
      this.publishStatus(false, T.starting);
      await this.load(gen);
      if (gen !== this.generation || !this.loaded) return;
    }
    this.configFailures = 0;
    await this.readConfig(gen);
  }

  /** Reads the configuration from Gladys; a failure is retried for ever, spaced. */
  async readConfig(gen) {
    if (this.configTimer) this.timers.clearTimeout(this.configTimer);
    this.configTimer = undefined;
    let config;
    try {
      config = await this.gladys.getConfig();
    } catch (err) {
      if (gen !== this.generation || !this.running) return;
      this.configFailures += 1;
      const wait = Math.min(CONFIG_RETRY * 2 ** (this.configFailures - 1), CONFIG_RETRY_MAX);
      this.logger.warn(
        `Configuration not read (${err?.name ?? 'Error'}): asked again in ${wait / 1000} s`,
      );
      this.configRetryAt = this.now() + wait;
      this.publishStatus();
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        this.readConfig(gen).catch((e) => this.logger.error(`Config failed (${e?.name})`));
      }, wait);
      return;
    }
    if (gen !== this.generation || !this.running) return;
    this.configFailures = 0;
    this.configRetryAt = undefined;
    await this.configure(config);
    const resume = () => this.tick(gen);
    if (this.checking) this.checking.then(resume, resume);
    else resume();
    await this.refreshContracts(gen);
    // What the calendar lost (a Gladys database restored) is sent again.
    await this.checkCalendar(gen);
    if (gen !== this.generation) return;
    // What the calendar missed while disconnected: no request to the API for that.
    await this.publishCalendar(gen);
  }

  /** The configuration saved by the user (or read at a connection). */
  async configure(raw) {
    if (!this.loaded) {
      this.pendingConfig = raw;
      return;
    }
    const next = normalizeConfig(raw);
    const changed = this.config !== undefined && this.config.key !== next.key;
    this.config = next;
    if (changed) {
      // A changed key is always tried: the refusal and the errors of the old one go.
      this.meta.failures = 0;
      this.lastError = undefined;
      if (this.refused) {
        this.refused = undefined;
        this.refusedKey = undefined;
        await this.save();
      }
    }
    this.publishStatus();
    if (this.running && !this.checking) this.tick(this.generation);
  }

  async stop() {
    this.running = false;
    this.generation += 1;
    this.clearTimers();
    await this.checking?.catch(() => {});
    await this.publishing?.catch(() => {});
    // The last state on disk at a clean stop.
    if (this.loaded) await this.save();
  }

  clearTimers() {
    for (const name of ['timer', 'storeTimer', 'configTimer']) {
      if (this[name]) this.timers.clearTimeout(this[name]);
      this[name] = undefined;
    }
  }

  /** Every pending piece of work (tests). */
  async idle() {
    for (let i = 0; i < 10; i += 1) {
      await this.loading;
      await this.checking;
      await this.publishing;
      await this.statusJob;
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  // --- /data ----------------------------------------------------------------------

  /** Reads /data once; unreadable: read again every 10 s, nothing asked meanwhile. */
  async load(gen) {
    if (this.storeTimer) this.timers.clearTimeout(this.storeTimer);
    this.storeTimer = undefined;
    this.loading = (async () => {
      const result = await this.store.load();
      if (gen !== this.generation || !this.running) return;
      if (result.status === 'unreadable') {
        this.logger.warn('/data unreadable: read again in 10 s');
        this.publishStatus(false, T.storeUnreadable);
        this.storeTimer = this.timers.setTimeout(() => {
          this.storeTimer = undefined;
          if (gen === this.generation && this.running && !this.loading) {
            this.load(gen)
              .then(() => {
                if (gen === this.generation && this.loaded) return this.readConfig(gen);
                return undefined;
              })
              .catch((err) => this.logger.error(`Load failed (${err?.name})`));
          }
        }, STORE_RETRY);
        return;
      }
      if (result.status === 'ok') this.restore(result.data);
      this.loaded = true;
    })().finally(() => {
      this.loading = undefined;
    });
    await this.loading;
    if (this.loaded && this.pendingConfig !== undefined) {
      const raw = this.pendingConfig;
      this.pendingConfig = undefined;
      await this.configure(raw);
    }
  }

  /** The state of /data, each part checked; a part that does not read is dropped. */
  restore(data) {
    const now = this.now();
    const mono = this.monotonic();
    this.meta.attemptAt = pastDate(data.attemptAt, now);
    // The time since the last attempt, capped: a restart never asks sooner.
    if (this.meta.attemptAt !== undefined) {
      this.attemptMono = mono - Math.min(now - this.meta.attemptAt, MAX_RETRY);
    }
    this.meta.checkedAt = pastDate(data.checkedAt, now);
    this.meta.failures =
      Number.isInteger(data.failures) && data.failures >= 0 && data.failures < 1000
        ? data.failures
        : 0;
    // A pause past its maximum is capped: its rest counts from now on the monotonic clock.
    const pause = data.pause;
    if (
      pause &&
      typeof pause.until === 'number' &&
      Number.isFinite(pause.until) &&
      pause.until > now
    ) {
      const left = Math.min(pause.until - now, PAUSE_MAX);
      this.pause = { until: now + left, due: mono + left };
    }
    this.lastError = REASON_CODES.includes(data.lastError) ? data.lastError : undefined;
    this.refused = validRefused(data.refused);
    if (!this.refused && this.lastError === 'refused') this.lastError = undefined;
    const today = dayOf(now);
    const oldest = addDays(today, -KEEP_DAYS);
    const days = data.days && typeof data.days === 'object' ? data.days : {};
    for (const [day, value] of Object.entries(days)) {
      if (!DAY_PATTERN.test(day) || day < oldest || day > today) continue;
      const record = restoreDay(day, value);
      if (record && record.known > 0) this.days.set(day, record);
      else this.logger.warn(`Stored prices for ${day} unusable: asked again`);
    }
    const incomplete =
      data.incomplete && typeof data.incomplete === 'object' ? data.incomplete : {};
    for (const [day, at] of Object.entries(incomplete)) {
      const when = pastDate(at, now);
      if (DAY_PATTERN.test(day) && when !== undefined) this.incomplete.set(day, when);
    }
    const sent = data.sent && typeof data.sent === 'object' ? data.sent : {};
    for (const [day, sig] of Object.entries(sent)) {
      if (DAY_PATTERN.test(day) && typeof sig === 'string' && /^[0-9a-f]{16}$/.test(sig)) {
        this.sent[day] = sig;
      }
    }
  }

  stateToSave() {
    const days = {};
    for (const [day, record] of [...this.days.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      days[day] = record.prices;
    }
    return {
      ...this.meta,
      pause: this.pause ? { until: this.pause.until } : undefined,
      lastError: this.lastError,
      refused: this.refused,
      days,
      incomplete: Object.fromEntries(this.incomplete),
      sent: this.sent,
    };
  }

  /**
   * One write at a time, bounded in time: a write that hangs counts as a
   * failed one (the data stays in memory) and the next saves are skipped
   * until it ends. Never throws.
   */
  async save() {
    if (this.saving) {
      this.dataError = 'timeout';
      return false;
    }
    let timer;
    const job = Promise.resolve().then(() => this.store.save(this.stateToSave()));
    this.saving = job.then(
      () => {},
      () => {},
    );
    this.saving.then(() => {
      this.saving = undefined;
    });
    const late = new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve('timeout'), SAVE_TIMEOUT);
    });
    try {
      const result = await Promise.race([job.then(() => 'ok'), late]);
      this.dataError = result === 'ok' ? undefined : 'timeout';
    } catch (err) {
      this.logger.warn(`Could not write /data: ${err?.code ?? 'error'}`);
      this.dataError = 'write';
    } finally {
      this.timers.clearTimeout(timer);
    }
    if (this.dataError === 'timeout') this.logger.warn('Writing /data takes too long: skipped');
    return this.dataError === undefined;
  }

  // --- The key --------------------------------------------------------------------

  /** The key held is the one the AESO refused (exactly in memory, by its tag after a restart). */
  keyRefused() {
    if (!this.refused || !this.config?.key) return false;
    if (this.refusedKey !== undefined) return this.config.key === this.refusedKey;
    return tagOf(this.refused.salt, this.config.key) === this.refused.tag;
  }

  /** Everything needed to ask: /data read, a valid key not refused. */
  ready() {
    return (
      this.tzCurrent &&
      this.loaded &&
      this.config !== undefined &&
      !this.config.problem &&
      !this.keyRefused()
    );
  }

  // --- What to ask, and when --------------------------------------------------------

  /** Every hour of `day` up to `expected` is held. */
  /**
   * Every hour of `day` up to `expected` is held, or was unreadable at the
   * AESO less than a day before `now` (asked again a day later, so one bad
   * hour never holds back the hourly rhythm).
   */
  done(day, expected, now = expected) {
    const record = this.days.get(day);
    const start = dayStart(day);
    const count = hoursOf(day);
    for (let k = 0; k < count; k += 1) {
      const t = start + k * HOUR;
      if (t > expected) break;
      if (!record || record.prices[k] === null) {
        const until = this.unreadable.get(t);
        if (until !== undefined && until > now) continue;
        return false;
      }
    }
    return true;
  }

  /** The first day to hold: the backfill, or the earliest contract (a year and a month at most). */
  firstDay(today) {
    let first = addDays(today, 1 - BACKFILL_DAYS);
    if (this.earliest && this.earliest < first) first = this.earliest;
    const oldest = addDays(today, 1 - KEEP_DAYS);
    return first < oldest ? oldest : first;
  }

  /**
   * The days to ask at `now` (most recent first), and when the plan changes
   * by itself: `{ days, wake }`. A day answered incomplete waits 10 minutes
   * (today, yesterday) or a day (an older one) before it is asked again.
   */
  plan(now) {
    const today = dayOf(now);
    const expected = lastExpected(now);
    const last = dayOf(expected);
    const days = [];
    let wake = nextPublication(now);
    // An unreadable hour is asked again when its day of waiting ends.
    for (const until of this.unreadable.values()) if (until > now) wake = Math.min(wake, until);
    for (const day of daysBetween(this.firstDay(today), last).reverse()) {
      if (this.done(day, expected, now)) continue;
      const at = this.incomplete.get(day);
      if (at !== undefined) {
        const again = at + (day >= addDays(today, -1) ? WAIT_PUBLICATION : EMPTY_RETRY);
        if (again > now) {
          wake = Math.min(wake, again);
          continue;
        }
      }
      days.push(day);
    }
    return { days, wake };
  }

  /** The earliest the next request may leave, on one reading of the monotonic clock. */
  dueAt(mono) {
    let due = mono;
    if (this.attemptMono !== undefined) {
      let gap = MIN_GAP;
      if (this.lastError === 'retired') gap = RETIRED_RETRY;
      else if (this.meta.failures > 0) gap = this.interval(this.meta.failures);
      due = this.attemptMono + gap;
    }
    if (this.pause && this.pause.due > due) due = this.pause.due;
    return due;
  }

  interval(failures) {
    return Math.min(RETRY_STEPS[Math.min(failures, RETRY_STEPS.length) - 1], MAX_RETRY);
  }

  /** Decides now: a check when an hour is lacking and the gap allows it, else sleeps. */
  tick(gen) {
    if (gen !== this.generation || !this.running) return;
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
    if (this.checking || !this.ready()) return;
    const now = this.now();
    const mono = this.monotonic();
    const { days, wake } = this.plan(now);
    let delay = wake - now;
    this.retryAt = undefined;
    if (days.length > 0) {
      const due = this.dueAt(mono);
      if (due <= mono) {
        this.check(gen, days).catch((err) => this.logger.error(`Check failed (${err?.name})`));
        return;
      }
      delay = Math.min(delay, due - mono);
      // The time shown in the status: the real next attempt, not the wake-up.
      if (this.lastError) this.retryAt = now + (due - mono);
    }
    this.sleep(gen, Math.min(Math.max(0, delay), MAX_SLEEP));
  }

  sleep(gen, ms) {
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      this.tick(gen);
    }, ms);
  }

  // --- Asking the API ------------------------------------------------------------

  check(gen, days, options) {
    if (this.checking || gen !== this.generation || !this.running) return this.checking;
    const job = this.runCheck(gen, days, options).finally(() => {
      // Only this check: a newer one started by the schedule stays tracked.
      if (this.checking === job) this.checking = undefined;
    });
    this.checking = job;
    return job;
  }

  /** Contiguous runs of at most 31 days, most recent first. */
  static chunks(days) {
    const sorted = [...days].sort().reverse();
    const runs = [];
    for (const day of sorted) {
      const run = runs[runs.length - 1];
      if (run && run.length < MAX_DAYS_PER_REQUEST && addDays(day, 1) === run[run.length - 1]) {
        run.push(day);
      } else runs.push([day]);
    }
    return runs.map((run) => run.reverse());
  }

  /** The URL of a run: `endDate` only when the run has more than one day (it must follow startDate). */
  static url(run) {
    const first = run[0];
    const last = run[run.length - 1];
    return last === first
      ? `${API_URL}?startDate=${first}`
      : `${API_URL}?startDate=${first}&endDate=${last}`;
  }

  /**
   * Asks the runs of `days` one after the other (one request in flight),
   * stops at the first failure. Resolves `{ ok, error, hours, last, price }`
   * (the button tells it).
   */
  async runCheck(gen, days, { runs: maxRuns = RUNS_PER_CHECK } = {}) {
    const key = this.config.key;
    // The attempt is dated in /data before the first request: a restart in
    // the middle never asks again sooner.
    this.attemptMono = this.monotonic();
    this.meta.attemptAt = this.now();
    await this.save();
    if (gen !== this.generation) return { ok: false, error: 'restarted' };
    let failure;
    let changed = false;
    const summary = { hours: 0, last: undefined, price: undefined };
    for (const run of App.chunks(days).slice(0, maxRuns)) {
      try {
        const { json } = await getJson(App.url(run), {
          key,
          limit: MAX_ANSWER_BYTES,
          fetchImpl: this.fetchImpl,
          now: this.now,
        });
        let answer;
        try {
          answer = parseAnswer(json, this.now());
        } catch (err) {
          if (!(err instanceof DataError)) throw err;
          throw new SourceError('invalid', `The AESO Pool Price Report: ${err.message}`);
        }
        if (gen !== this.generation) return { ok: false, error: 'restarted' };
        if (this.take(run, answer)) changed = true;
        for (const [start, price] of answer.hours) {
          summary.hours += 1;
          if (summary.last === undefined || start + HOUR > summary.last) {
            summary.last = start + HOUR;
            summary.price = price;
          }
        }
        // No hour of the answer reads while hours are expected: a broken
        // answer (a changed format or clock), never a quiet success.
        const now = this.now();
        const expected = lastExpected(now);
        if (
          answer.hours.size === 0 &&
          answer.refused > 0 &&
          !run.every((day) => this.done(day, expected, now))
        ) {
          throw new SourceError(
            'invalid',
            `The AESO Pool Price Report: ${answer.refused} hour(s) unreadable, none readable`,
          );
        }
        // Some hours do not read: those wait a day, the others go on (said in the status).
        for (const start of answer.bad) {
          const day = dayOf(start);
          const record = this.days.get(day);
          const k = record ? (start - record.start) / HOUR : -1;
          if ((!record || record.prices[k] === null) && !(this.unreadable.get(start) > now)) {
            // Dated from the first time it did not read: seen again meanwhile, the day stays.
            this.unreadable.set(start, now + EMPTY_RETRY);
          }
        }
      } catch (err) {
        if (gen !== this.generation) return { ok: false, error: 'restarted' };
        if (!(err instanceof SourceError)) throw err;
        // The other runs wait for the next attempt: never a storm on a failing API.
        failure = err;
        break;
      }
    }
    const now = this.now();
    const mono = this.monotonic();
    if (!failure) {
      this.meta.failures = 0;
      this.pause = undefined;
      this.meta.checkedAt = now;
      this.lastError = undefined;
      if (this.refused && this.config.key === key) {
        // The button succeeded with the key refused before (or a tag shared by chance).
        this.refused = undefined;
        this.refusedKey = undefined;
      }
    } else if (failure.code === 'refused') {
      this.logger.warn('The AESO refused the API key (401): nothing is asked until it changes');
      // Only the key that was sent: a key changed meanwhile is tried at once.
      if (this.config.key === key) {
        const salt = this.random(16).toString('hex');
        this.refused = { salt, tag: tagOf(salt, key) };
        this.refusedKey = key;
        this.lastError = 'refused';
      }
    } else {
      this.meta.failures += 1;
      this.lastError = failure.code;
      this.logger.warn(`AESO check failed: ${failure.message}`);
      if (failure.code === 'rate_limited') {
        const pause = Math.min(Math.max(failure.retryAfter ?? PAUSE_DEFAULT, PAUSE_MIN), PAUSE_MAX);
        this.pause = { until: now + pause, due: mono + pause };
      }
    }
    this.prune(now);
    await this.save();
    if (gen !== this.generation) return { ok: false, error: 'restarted' };
    if (this.contractsMono === undefined || mono - this.contractsMono >= CONTRACTS_EVERY) {
      await this.refreshContracts(gen);
    }
    // The back-off, the pause and the retired gap are decided by dueAt() from
    // the time of this attempt, on a timer: a check never chains into the next
    // one without going through the schedule.
    this.checking = undefined;
    this.sleep(gen, 0);
    this.publishStatus();
    if (changed || this.calendarIssue) await this.publishCalendar(gen);
    return failure ? { ok: false, error: failure.code } : { ok: true, ...summary };
  }

  /**
   * Takes the hours of one answer for the days of `run` (only those); an hour
   * held and absent from the answer is kept (an answer never erases a price),
   * an hour answered with another price is corrected. Returns whether a day
   * changed.
   */
  take(run, answer) {
    const now = this.now();
    const expected = lastExpected(now);
    let changed = false;
    if (answer.refused > 0) {
      this.logger.warn(`AESO answer: ${answer.refused} hour(s) unreadable, left unknown`);
    }
    for (const day of run) {
      const fresh = dayRecord(day, answer.hours);
      const held = this.days.get(day);
      let record = fresh;
      if (held) {
        record = { start: fresh.start, prices: [], known: 0 };
        for (let k = 0; k < fresh.prices.length; k += 1) {
          const price = fresh.prices[k] === null ? held.prices[k] : fresh.prices[k];
          record.prices.push(price);
          if (price !== null) record.known += 1;
        }
      }
      if (record.known > 0 && !sameDay(record, held)) {
        if (held && held.prices.some((p, k) => p !== null && record.prices[k] !== p)) {
          this.logger.info(`AESO pool prices of ${day} corrected`);
        }
        this.days.set(day, record);
        changed = true;
      }
      if (this.done(day, expected, now)) this.incomplete.delete(day);
      else this.incomplete.set(day, now);
    }
    return changed;
  }

  /** Days older than a year and a month leave memory and /data. */
  prune(now) {
    const oldest = addDays(dayOf(now), -KEEP_DAYS);
    for (const day of this.days.keys()) if (day < oldest) this.days.delete(day);
    for (const day of this.incomplete.keys()) if (day < oldest) this.incomplete.delete(day);
    for (const day of Object.keys(this.sent)) if (day < oldest) delete this.sent[day];
    for (const [t, until] of this.unreadable) if (until <= now) this.unreadable.delete(t);
  }

  /** The price of the hour starting at `t` is held. */
  heldAt(t) {
    const record = this.days.get(dayOf(t));
    return Boolean(record) && typeof record.prices[(t - record.start) / HOUR] === 'number';
  }

  // --- Calendar -------------------------------------------------------------------

  /**
   * Publishes to the calendar the days it has not received as they are now
   * (the known hours only, two 30-minute slots each, CAD/kWh), in batches of
   * 2,000 entries; a failure stops until the next check or reconnection.
   */
  async publishCalendar(gen) {
    if (this.publishing) return this.publishing;
    const job = this.runPublish(gen).finally(() => {
      if (this.publishing === job) this.publishing = undefined;
    });
    this.publishing = job;
    return job;
  }

  async runPublish(gen) {
    if (!this.loaded) return;
    const pending = [];
    for (const [day, record] of [...this.days.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const sig = signature(record.prices);
      if (this.sent[day] !== sig) pending.push({ day, record, sig });
    }
    if (pending.length === 0) {
      this.calendarIssue = undefined;
      this.publishStatus();
      return;
    }
    let any = false;
    let batch = [];
    let days = [];
    const flush = async () => {
      if (batch.length === 0) return true;
      const ok = await this.sendCalendar(batch);
      if (gen !== this.generation) return false;
      if (!ok.sent) {
        this.calendarIssue = ok.issue;
        return false;
      }
      for (const { day, sig } of days) this.sent[day] = sig;
      any = true;
      batch = [];
      days = [];
      return true;
    };
    let stopped = false;
    for (const item of pending) {
      const entries = [];
      item.record.prices.forEach((price, k) => {
        if (price === null) return;
        const start = item.record.start + k * HOUR;
        for (const slot of [start, start + HALF_HOUR]) {
          entries.push({
            starts_at: new Date(slot).toISOString(),
            price: perKwh(price),
            currency: CURRENCY,
          });
        }
      });
      if (batch.length + entries.length > CALENDAR_BATCH && !(await flush())) {
        stopped = true;
        break;
      }
      batch.push(...entries);
      days.push(item);
    }
    if (!stopped && (await flush())) this.calendarIssue = undefined;
    if (gen !== this.generation) return;
    if (any) await this.save();
    this.publishStatus();
  }

  /** One read of the calendar from Gladys, bounded in time: the entries, or undefined. */
  async readCalendar(options) {
    let timer;
    const late = new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve('timeout'), CALENDAR_TIMEOUT);
    });
    try {
      const job = Promise.resolve().then(() => this.gladys.getEnergyCalendar(CALENDAR, options));
      const entries = await Promise.race([job, late]);
      if (entries === 'timeout') {
        job.catch(() => {});
        this.logger.warn(`Calendar ${CALENDAR}: not read back in time`);
        return undefined;
      }
      return Array.isArray(entries) ? entries : undefined;
    } catch (err) {
      this.logger.warn(
        `Calendar ${CALENDAR} not read back: ${err?.status ?? err?.name ?? 'error'}`,
      );
      return undefined;
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  /**
   * At a connection, what Gladys lost of the calendar is sent again. A
   * database restored loses the END of the calendar; the nightly retention of
   * the core purges its BEGINNING, which must never be sent again (it would be
   * purged the next night, and every resend queues a recalculation). So only
   * the days from the day of the last entry Gladys holds are read back (one
   * call for that entry, then 20 days a call), and a day whose slots are not
   * all there is sent again; an empty calendar is sent again whole, once. A
   * read that fails or hangs changes nothing (secondary, 20 s at most).
   */
  async checkCalendar(gen) {
    const sentDays = Object.keys(this.sent)
      .filter((day) => this.days.has(day))
      .sort();
    if (sentDays.length === 0) return;
    const last = await this.readCalendar({ limit: 1 });
    if (gen !== this.generation || last === undefined) return;
    const lastAt = Date.parse(last[0]?.starts_at);
    if (!Number.isFinite(lastAt)) {
      // Nothing left at all: not a purge (it keeps the recent days), a loss.
      for (const day of sentDays) delete this.sent[day];
      return;
    }
    const days = sentDays.filter((day) => day >= dayOf(lastAt));
    for (let i = 0; i < days.length; i += CALENDAR_READ_DAYS) {
      const slice = days.slice(i, i + CALENDAR_READ_DAYS);
      const from = dayStart(slice[0]);
      const to = dayStart(addDays(slice[slice.length - 1], 1));
      const entries = await this.readCalendar({
        from: new Date(from).toISOString(),
        to: new Date(to - 1).toISOString(),
      });
      if (gen !== this.generation || entries === undefined) return;
      const held = new Set();
      for (const entry of entries) {
        const t = Date.parse(entry?.starts_at);
        if (Number.isFinite(t)) held.add(t);
      }
      for (const day of slice) {
        const record = this.days.get(day);
        const whole = record.prices.every(
          (price, k) =>
            price === null ||
            (held.has(record.start + k * HOUR) && held.has(record.start + k * HOUR + HALF_HOUR)),
        );
        if (!whole) delete this.sent[day];
      }
    }
  }

  /** One calendar batch, bounded in time: `{ sent }` or `{ sent: false, issue }`. Never throws. */
  async sendCalendar(entries) {
    let timer;
    const late = new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve('timeout'), CALENDAR_TIMEOUT);
    });
    try {
      const job = Promise.resolve().then(() =>
        this.gladys.publishEnergyCalendar(CALENDAR, entries),
      );
      const result = await Promise.race([job.then(() => 'ok'), late]);
      if (result === 'timeout') {
        job.catch(() => {});
        this.logger.warn(`Calendar ${CALENDAR}: no answer in time`);
        return { sent: false, issue: 'error' };
      }
      return { sent: true };
    } catch (err) {
      const status = err?.status ?? err?.statusCode;
      this.logger.warn(`Calendar ${CALENDAR} not fed: ${status ?? err?.name ?? 'error'}`);
      return { sent: false, issue: status === 403 ? 'refused' : 'error' };
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  // --- Contracts (status and backfill only) -----------------------------------------

  /** The contracts on the template, read from Gladys (secondary: a failure changes nothing). */
  async refreshContracts(gen) {
    this.contractsMono = this.monotonic();
    let list;
    try {
      list = await this.gladys.getEnergyContracts();
    } catch (err) {
      this.logger.warn(`Contracts not read: ${err?.status ?? err?.name ?? 'error'}`);
      return;
    }
    if (gen !== this.generation || !Array.isArray(list)) return;
    const ours = list
      .slice(0, MAX_CONTRACTS)
      .filter((c) => c && typeof c === 'object' && c.template_key === TEMPLATE);
    this.contracts = ours.length;
    let earliest;
    for (const contract of ours) {
      const from = typeof contract.valid_from === 'string' ? contract.valid_from.slice(0, 10) : '';
      if (DAY_PATTERN.test(from) && (!earliest || from < earliest)) earliest = from;
    }
    const before = this.earliest;
    this.earliest = earliest;
    this.publishStatus();
    if (earliest !== before && this.running && !this.checking) this.tick(gen);
  }

  // --- Status ---------------------------------------------------------------------

  /**
   * Publishes the status in the background (one at a time, in order, each
   * bounded in time); a state already published is not sent again. Returns
   * the promise of the publication, which never rejects.
   */
  publishStatus(connected, message) {
    let state = { connected, message };
    if (message === undefined) state = this.statusState();
    const key = JSON.stringify(state);
    if (key === this.lastStatus) return this.statusJob;
    this.lastStatus = key;
    this.statusJob = this.statusJob.then(() => this.sendStatus(state));
    return this.statusJob;
  }

  statusState() {
    if (!this.tzCurrent) return { connected: false, message: T.tzStale };
    if (!this.loaded) return { connected: false, message: T.starting };
    if (this.configRetryAt !== undefined) {
      return { connected: false, message: T.configUnreadable(this.configRetryAt) };
    }
    if (this.config === undefined) return { connected: false, message: T.starting };
    if (this.config.problem) return { connected: false, message: T[this.config.problem] };
    if (this.keyRefused()) return { connected: false, message: T.refused };
    const now = this.now();
    let through;
    for (const record of this.days.values()) {
      record.prices.forEach((price, k) => {
        const end = record.start + (k + 1) * HOUR;
        if (price !== null && (through === undefined || end > through)) through = end;
      });
    }
    return {
      connected: this.meta.checkedAt !== undefined && !this.lastError,
      message: T.status({
        through,
        checkedAt: this.meta.checkedAt,
        error: this.lastError,
        retryAt: this.retryAt,
        calendar: this.calendarIssue,
        contracts: this.contracts,
        dataError: this.dataError,
        unreadable: [...this.unreadable].filter(([t, until]) => until > now && !this.heldAt(t))
          .length,
      }),
    };
  }

  async sendStatus(state) {
    let timer;
    const late = new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve('timeout'), STATUS_TIMEOUT);
    });
    try {
      const sent = Promise.resolve().then(() =>
        this.gladys.setConnectionStatus(state.connected, state.message),
      );
      if ((await Promise.race([sent.then(() => 'ok'), late])) === 'timeout') {
        sent.catch(() => {});
        this.logger.warn('Status not published in time');
      }
    } catch (err) {
      this.logger.warn(`Status not published: ${err?.name ?? 'error'}`);
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  // --- The "Test the key" button ----------------------------------------------------

  /**
   * One request with the key saved (today's settled hours, or the oldest
   * missing ones), never closer than a minute to the last one nor during a
   * pause. A success lifts a refusal of that key.
   */
  async testKey() {
    if (!this.tzCurrent) return T.tzStale;
    if (!this.loaded || !this.running) return T.testStarting;
    if (this.config === undefined) {
      // The button before the configuration was read: read it now, once.
      try {
        await this.configure(await this.gladys.getConfig());
      } catch {
        return T.testStarting;
      }
    }
    if (this.config.problem) return T[this.config.problem];
    if (this.checking) return T.testBusy;
    const mono = this.monotonic();
    if (this.pause && this.pause.due > mono) return T.testPaused(this.pause.until);
    if (this.attemptMono !== undefined && mono - this.attemptMono < MIN_GAP) {
      return T.testTooSoon(Math.ceil((MIN_GAP - (mono - this.attemptMono)) / 1000));
    }
    const now = this.now();
    const { days } = this.plan(now);
    const asked = days.length > 0 ? days : [dayOf(now)];
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
    const result = await this.check(this.generation, asked, { runs: 1 });
    if (!result) return T.testBusy;
    if (result.ok) return T.testOk(result);
    if (result.error === 'restarted') return T.testStarting;
    return T.testFailed(result.error);
  }
}
