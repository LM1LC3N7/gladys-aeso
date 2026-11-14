// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here. When the Gladys
// core is cloned next to this repository (~/code/Gladys), its own manifest
// validator and its rule engine are run too.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACTION_TEST,
  CALENDAR,
  CONFIG_KEY,
  CURRENCY,
  INPUTS,
  TEMPLATE,
  TIMEZONE,
} from '../src/constants.js';
import { perKwh } from '../src/data.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const handlers = read('src/handlers.js');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) yield* texts(item, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

function* objects(node) {
  if (Array.isArray(node)) {
    for (const item of node) yield* objects(item);
  } else if (node && typeof node === 'object') {
    yield node;
    for (const value of Object.values(node)) yield* objects(value);
  }
}

test('the store basics', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'provider', 'no device: capabilities only');
  assert.equal(manifest.gladys_version, '>=5.3.0', 'countries needs Gladys 5.3');
  assert.deepEqual(manifest.categories, ['energy']);
  assert.deepEqual(manifest.transports, ['cloud']);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    assert.ok(read(`docs/${lang}.md`).length >= 300, `docs/${lang}.md is too short for the store`);
  }
  assert.match(manifest.description.en, /^Unofficial/);
  assert.match(manifest.description.fr, /^Non officiel/);
  assert.equal(manifest.keywords, undefined);
  assert.deepEqual(manifest.countries, ['CA'], 'Alberta only (Canada)');
  for (const code of manifest.countries) assert.match(code, /^[A-Z]{2}$/);
});

test('one version everywhere, semver, never pinned by hand twice', () => {
  const semver = /^\d+\.\d+\.\d+$/;
  assert.match(pkg.version, semver);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-aeso:${pkg.version}`);
  assert.match(manifest.gladys_version, /^>=\d+\.\d+\.\d+$/, 'a range, never one version');
  assert.equal(pkg.scripts.test, 'node --test --test-timeout=60000');
});

test('every text is bilingual, and the words the rules forbid are absent', () => {
  for (const [path, text] of texts(manifest)) {
    assert.ok(text.en?.trim() && text.fr?.trim(), `${path} needs en and fr`);
  }
  const all = [
    'gladys-assistant-integration.json',
    'README.md',
    'docs/en.md',
    'docs/fr.md',
    'src/i18n.js',
    'CHANGELOG.md',
  ]
    .map(read)
    .join('\n');
  assert.doesNotMatch(all, /chiffr|encrypt|hachage/i);
});

test('the configuration: the key is a secret without default, no key prefixed gladys_, one button', () => {
  for (const field of manifest.config_schema) {
    assert.doesNotMatch(field.key, /^gladys_/i);
    if (field.type === 'section') assert.equal(field.default, undefined);
    for (const link of field.links ?? []) assert.match(link.url, /^https:\/\//);
  }
  const key = manifest.config_schema.find((f) => f.key === CONFIG_KEY);
  assert.equal(key.type, 'secret');
  assert.equal(key.required, true);
  assert.equal(key.default, undefined, 'never a default secret');
  assert.match(
    key.description.en,
    /Kept by Gladys in its database, never shown again, sent only to the AESO/,
  );
  assert.match(
    key.description.fr,
    /Gardée par Gladys dans sa base, jamais réaffichée, envoyée seulement à l’AESO/,
  );
  assert.deepEqual(
    manifest.actions.map((a) => a.key),
    [ACTION_TEST],
  );
  assert.ok(handlers.includes('onAction(ACTION_TEST'));
  assert.ok(!handlers.includes('onEnergyPrice'), 'rules mode: priced by the core');
});

test('the source is named in the manifest, the docs and the notices', () => {
  const intro = manifest.config_schema.find((f) => f.key === 'intro');
  for (const lang of ['en', 'fr']) {
    assert.match(intro.description[lang], /AESO/);
    assert.match(intro.description[lang], /^(Unofficial|Non officiel)/);
  }
  for (const file of ['README.md', 'docs/en.md', 'docs/fr.md', 'THIRD_PARTY_NOTICES.md']) {
    assert.match(read(file), /apimgw\.aeso\.ca\/public\/poolprice-api\/v1\.1/, file);
  }
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /COPY LICENSE THIRD_PARTY_NOTICES\.md/);
  assert.doesNotMatch(read('LICENSE'), /Copyright \d{4} [A-Z]/, 'no personal name');
});

test('the template and the calendar match the code', () => {
  const { templates, calendars } = manifest.energy_contracts;
  assert.deepEqual(
    templates.map((t) => t.key),
    [TEMPLATE],
  );
  const [template] = templates;
  assert.equal(template.pricing_mode, 'rules');
  assert.equal(template.country, 'CA');
  assert.equal(template.currency, CURRENCY);
  assert.equal(template.timezone, TIMEZONE);
  assert.deepEqual(template.calendars, [CALENDAR]);
  assert.deepEqual(template.inputs.map((i) => i.key).sort(), Object.values(INPUTS).sort());
  const provisional = template.inputs.find((i) => i.key === INPUTS.PROVISIONAL);
  assert.equal(provisional.required, true, 'the provisional price is typed, never a default');
  assert.equal(provisional.default, undefined);
  const energy = template.tariff.components.find((c) => c.key === 'energy');
  assert.equal(energy.rules[0].price_from_calendar, CALENDAR);
  assert.equal(energy.fallback.price, `{{input:${INPUTS.PROVISIONAL}}}`);
  assert.deepEqual(
    calendars,
    [{ key: CALENDAR, granularity: 'thirty_minutes', currency: CURRENCY, timezone: TIMEZONE }],
    'the granularity of a key never changes; a price calendar has no values',
  );
});

test('every select option follows the core rules (label, value, unique)', () => {
  // No feature here: the rule is checked on every select the manifest may carry.
  for (const node of objects(manifest)) {
    if (node.type !== 'select' || !Array.isArray(node.options)) continue;
    const values = node.options.map((o) => o.value);
    assert.equal(new Set(values).size, values.length);
    for (const option of node.options) {
      assert.ok(typeof option.value === 'string' || Number.isInteger(option.value));
    }
  }
  assert.equal(JSON.stringify(manifest).includes('supported_options'), false);
});

const core = join(homedir(), 'code/Gladys/server/lib');
const coreCloned = existsSync(
  join(core, 'external-integration/externalIntegration.validateManifest.js'),
);

/** Runs `script` in a child process in a temporary directory (the core opens files where it runs). */
async function runCore(t, script) {
  const dir = await mkdtemp(join(tmpdir(), 'aeso-core-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 30_000,
  });
  const line = result.stdout.split('\n').find((l) => l.startsWith('RESULT'));
  assert.ok(line, `${result.stdout}\n${result.stderr}`.slice(-2000));
  return JSON.parse(line.slice(6));
}

test(
  'the Gladys core validator accepts the manifest, and the tariff only with a provisional price',
  { skip: !coreCloned && 'Gladys core not cloned' },
  async (t) => {
    const tariff = manifest.energy_contracts.templates[0].tariff;
    const out = await runCore(
      t,
      `
      const mod = require(${JSON.stringify(join(core, 'external-integration/externalIntegration.validateManifest.js'))});
      const { validateContractTariff } = require(${JSON.stringify(join(core, 'energy-contract/contract.validate.js'))});
      const validate = mod.validateManifest ?? mod;
      const out = {};
      try { validate(${JSON.stringify(manifest)}); out.manifest = 'ok'; } catch (err) { out.manifest = err.message; }
      const inputs = { adder_cad_kwh: 0.01, delivery_cad_kwh: 0.05, fixed_cad_month: 30, gst_percent: 5 };
      for (const [name, value] of [['with', { ...inputs, provisional_cad_kwh: 0.1 }], ['without', inputs]]) {
        try { validateContractTariff(${JSON.stringify(tariff)}, value, 'rules'); out[name] = 'ok'; }
        catch (err) { out[name] = 'refused'; }
      }
      console.log('RESULT' + JSON.stringify(out));
    `,
    );
    assert.deepEqual(out, { manifest: 'ok', with: 'ok', without: 'refused' });
  },
);

test(
  'the core rule engine prices an hour from the calendar, and the provisional price where none is published',
  { skip: !coreCloned && 'Gladys core not cloned' },
  async (t) => {
    const tariff = manifest.energy_contracts.templates[0].tariff;
    const price = perKwh(45.67);
    // 08:00 MT on 2026-11-14 (UTC-6): the hour 14:00Z published, 15:00Z not.
    const out = await runCore(
      t,
      `
      const { compileTariff } = require(${JSON.stringify(join(core, 'energy-contract/tariff.compile.js'))});
      const { priceIntervals } = require(${JSON.stringify(join(core, 'energy-contract/tariff.priceIntervals.js'))});
      const { createCalendarLookup } = require(${JSON.stringify(join(core, 'energy-contract/calendar.lookup.js'))});
      const inputs = { adder_cad_kwh: 0.01, provisional_cad_kwh: 0.1, delivery_cad_kwh: 0.05, fixed_cad_month: 0, gst_percent: 5 };
      const compiled = compileTariff(${JSON.stringify(tariff)}, inputs);
      const lookup = createCalendarLookup(
        { 'spot-ca-ab': { granularity: 'thirty_minutes', timezone: 'America/Edmonton' } },
        [
          { calendar_key: 'spot-ca-ab', starts_at: '2026-11-14T14:00:00.000Z', value: ${price} },
          { calendar_key: 'spot-ca-ab', starts_at: '2026-11-14T14:30:00.000Z', value: ${price} },
        ],
        'America/Edmonton',
      );
      const run = priceIntervals(compiled, { timezone: 'America/Edmonton', billing_period_start_day: 1 }, [
        { starts_at: '2026-11-14T14:00:00Z', kwh: 2 },
        { starts_at: '2026-11-14T14:30:00Z', kwh: 1 },
        { starts_at: '2026-11-14T15:00:00Z', kwh: 1 },
      ], { calendars: lookup, exclude_kinds: ['fixed'] });
      console.log('RESULT' + JSON.stringify({ costs: run.costs.map((c) => [c.cost, c.label]), warnings: run.warnings.length }));
    `,
    );
    const [a, b, c] = out.costs;
    const close = (x, y) => assert.ok(Math.abs(x - y) < 1e-6, `${x} vs ${y}`);
    close(a[0], 2 * (price + 0.01 + 0.05) * 1.05);
    close(b[0], 1 * (price + 0.01 + 0.05) * 1.05);
    close(c[0], 1 * (0.1 + 0.05) * 1.05);
    assert.equal(a[1], 'Pool price');
    assert.match(c[1], /Provisional/);
    assert.ok(out.warnings >= 1, 'the core warns of the missing calendar value');
  },
);
