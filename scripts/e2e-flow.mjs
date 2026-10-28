#!/usr/bin/env node
/**
 * THE END-TO-END GATE (Task 20).
 *
 *   npm run e2e [-- --no-http] [-- --no-build]
 *
 * One fresh tenant is seeded (the real seed: warehouse, 14 branches, pseudo
 * locations, users, items through the real importer), then the whole life of a
 * delivery is driven through the REAL WRITERS as the matching USER ROLES, and the
 * on-hand per location is asserted after EVERY step:
 *
 *   factory -> warehouse (manager)  -> request (branch04) -> approve+issue (manager)
 *   -> confirm (branch04) -> return (branch04) -> count with a -1 variance (manager)
 *
 * Then: the CONSERVATION INVARIANT (an independent ledger reconciliation that does
 * not read the `on_hand` view), TENANT ISOLATION (a second fresh tenant sees none
 * of the first's rows), and — from the CLI only — an HTTP + API smoke against a
 * PRODUCTION BUILD (`next build`, `next start` on a free port, killed afterwards).
 *
 * TWO CONNECTIONS, TWO JOBS. The OWNER (MIGRATE_DATABASE_URL) creates and deletes
 * the fresh tenants and nothing else. Every read and write the flow performs goes
 * through the NON-owner app role (APP_DATABASE_URL, or SQL_TEST_DATABASE_URL from
 * the test); a superuser / BYPASSRLS role is REFUSED, because the owner skips RLS
 * and a run as owner would prove nothing.
 *
 * CLEANUP is unconditional (try/finally): ledger rows are append-only, so the
 * fresh tenants are removed over the owner connection with
 * `session_replication_role = replica`, restricted to the tenant ids this run
 * created, and the run asserts ZERO rows are left for those ids.
 *
 * Exit code: 0 all green, 1 any failure (a reconciliation mismatch included).
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import pg from 'pg';

import { createAppPool } from '../src/db/app-pool.ts';
import { issueClient } from '../src/db/api-clients.ts';
import { withTenant } from '../src/db/client.ts';
import { closeCount, openCount, recordCount } from '../src/db/counts.ts';
import { createItem, findVariantById } from '../src/db/items.ts';
import { createLocation } from '../src/db/locations.ts';
import { movementHistory, onHand } from '../src/db/movements.ts';
import { createReceipt, postReceipt } from '../src/db/receipts.ts';
import { approve, confirmReceipt, createRequisition, issue } from '../src/db/requisitions.ts';
import { returnRequisition } from '../src/db/returns.ts';
import { DEMO_TENANT_ID, seedTenant } from './seed.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rnd = (n = 6) => randomBytes(n).toString('hex');

// ---------------------------------------------------------------------------
// Fixed-point helpers: numeric(12,3) arrives as text; never do float maths on it.
// ---------------------------------------------------------------------------
export function toMilli(s) {
  const m = /^(-?)(\d+)(?:\.(\d{1,3}))?$/.exec(String(s));
  if (!m) throw new Error(`not a decimal: ${s}`);
  const v = BigInt(m[2]) * 1000n + BigInt((m[3] ?? '').padEnd(3, '0'));
  return m[1] ? -v : v;
}
export function fromMilli(v) {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / 1000n;
  const frac = String(a % 1000n).padStart(3, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

// ---------------------------------------------------------------------------
// The conservation invariant
// ---------------------------------------------------------------------------

/**
 * Pure comparison: for every variant the `on_hand` view's total (summed across
 * ALL locations) must equal the ledger's own net (sum of qty where a `to` exists,
 * minus sum of qty where a `from` exists). Returns the mismatches (empty = good).
 */
export function compareReconciliation(viewTotals, ledgerNet) {
  const bad = [];
  const ids = new Set([...Object.keys(viewTotals), ...Object.keys(ledgerNet)]);
  for (const id of ids) {
    const v = viewTotals[id] ?? 0n;
    const l = ledgerNet[id] ?? 0n;
    if (v !== l) bad.push({ variantId: id, view: fromMilli(v), ledger: fromMilli(l) });
  }
  return bad;
}

/**
 * Reads, as the APP role inside one tenant scope, the per-location balances from
 * the `on_hand` view AND — independently, straight from `stock_movements` with no
 * reference to the view — the ledger net per variant and the net per reason.
 */
export async function reconcileTenant(appPool, tenantId, { tamperView } = {}) {
  return withTenant(appPool, tenantId, async (db) => {
    const variants = (await db.query(`select id, sku from item_variants order by sku`)).rows;
    const locs = new Map((await db.query(`select id, code, type from locations`)).rows.map((r) => [r.id, r]));
    let viewRows = (await db.query(`select variant_id, location_id, qty from on_hand`)).rows;
    if (tamperView) viewRows = tamperView(viewRows);

    // The ledger side: raw movements only. `ledger_net` is the spec's definition;
    // `internal_net` leaves out the vendor pseudo-location (stock that exists in the system).
    const ledger = (
      await db.query(
        `select m.variant_id,
                coalesce(sum(m.qty) filter (where m.to_location_id is not null), 0)::text as ins,
                coalesce(sum(m.qty) filter (where m.from_location_id is not null), 0)::text as outs,
                coalesce(sum(m.qty) filter (where m.to_location_id is not null and tl.type <> 'vendor'), 0)::text as ins_int,
                coalesce(sum(m.qty) filter (where m.from_location_id is not null and fl.type <> 'vendor'), 0)::text as outs_int
           from stock_movements m
           left join locations tl on tl.id = m.to_location_id
           left join locations fl on fl.id = m.from_location_id
          group by m.variant_id`,
      )
    ).rows;
    const byReason = (
      await db.query(
        `select m.variant_id, m.reason,
                (coalesce(sum(m.qty) filter (where tl.type <> 'vendor'), 0)
               - coalesce(sum(m.qty) filter (where fl.type <> 'vendor'), 0))::text as net
           from stock_movements m
           left join locations tl on tl.id = m.to_location_id
           left join locations fl on fl.id = m.from_location_id
          group by m.variant_id, m.reason`,
      )
    ).rows;

    const viewTotals = {};
    const viewInternal = {};
    const perLocation = {};
    for (const r of viewRows) {
      const q = toMilli(r.qty);
      viewTotals[r.variant_id] = (viewTotals[r.variant_id] ?? 0n) + q;
      const loc = locs.get(r.location_id);
      if (loc && loc.type !== 'vendor') {
        viewInternal[r.variant_id] = (viewInternal[r.variant_id] ?? 0n) + q;
        if (q !== 0n) (perLocation[r.variant_id] ??= {})[loc.code] = fromMilli(q);
      }
    }
    const ledgerNet = {};
    const ledgerInternal = {};
    for (const r of ledger) {
      ledgerNet[r.variant_id] = toMilli(r.ins) - toMilli(r.outs);
      ledgerInternal[r.variant_id] = toMilli(r.ins_int) - toMilli(r.outs_int);
    }
    const reasons = {};
    for (const r of byReason) (reasons[r.variant_id] ??= {})[r.reason] = fromMilli(toMilli(r.net));

    const mismatches = [
      ...compareReconciliation(viewTotals, ledgerNet).map((m) => ({ ...m, scope: 'all locations' })),
      ...compareReconciliation(viewInternal, ledgerInternal).map((m) => ({ ...m, scope: 'in-system (no vendor)' })),
    ];
    const rows = variants.map((v) => ({
      variantId: v.id,
      sku: v.sku,
      perLocation: perLocation[v.id] ?? {},
      systemTotal: fromMilli(viewInternal[v.id] ?? 0n),
      ledgerNet: fromMilli(ledgerInternal[v.id] ?? 0n),
      allLocationsView: fromMilli(viewTotals[v.id] ?? 0n),
      allLocationsLedger: fromMilli(ledgerNet[v.id] ?? 0n),
      reasons: reasons[v.id] ?? {},
    }));
    return { ok: mismatches.length === 0, mismatches, rows };
  });
}

export function assertReconciled(rec, label) {
  assert.equal(rec.ok, true, `${label}: on_hand view and ledger disagree: ${JSON.stringify(rec.mismatches.slice(0, 3))}`);
}

export function formatReconciliation(rec) {
  const lines = ['variant      per-location                        system  ledger-net  ok'];
  for (const r of rec.rows) {
    const per = Object.entries(r.perLocation).map(([c, q]) => `${c}=${q}`).join(' ') || '-';
    const ok = r.systemTotal === r.ledgerNet && r.allLocationsView === r.allLocationsLedger;
    lines.push(`${r.sku.padEnd(12)} ${per.padEnd(35).slice(0, 35)} ${r.systemTotal.padStart(7)} ${r.ledgerNet.padStart(11)}  ${ok ? 'yes' : 'NO'}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Owner-side cleanup
// ---------------------------------------------------------------------------

/** Deletes everything the given tenants own and returns the number of rows left (must be 0). */
export async function cleanupTenants(ownerUrl, ids) {
  if (ids.length === 0) return { rowsLeft: 0 };
  const c = new pg.Client({ connectionString: ownerUrl });
  await c.connect();
  try {
    await c.query('set session_replication_role = replica');
    const { rows } = await c.query(
      `select table_name from information_schema.columns
        where table_schema = 'public' and column_name = 'tenant_id'
          and table_name in (select table_name from information_schema.tables where table_type = 'BASE TABLE')`,
    );
    for (const { table_name } of rows) await c.query(`delete from "${table_name}" where tenant_id = any($1)`, [ids]);
    await c.query('delete from tenants where id = any($1)', [ids]);
    await c.query('set session_replication_role = origin');
    let left = Number((await c.query('select count(*) n from tenants where id = any($1)', [ids])).rows[0].n);
    for (const { table_name } of rows) {
      left += Number((await c.query(`select count(*) n from "${table_name}" where tenant_id = any($1)`, [ids])).rows[0].n);
    }
    return { rowsLeft: left };
  } finally {
    await c.query('set session_replication_role = origin').catch(() => {});
    await c.end().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

async function loadWorld(appPool, tenantId) {
  return withTenant(appPool, tenantId, async (db) => {
    const loc = Object.fromEntries((await db.query('select code, id from locations')).rows.map((r) => [r.code, r.id]));
    const user = Object.fromEntries((await db.query('select username, id from app_users')).rows.map((r) => [r.username, r.id]));
    return { loc, user };
  });
}

async function balances(appPool, tenantId, variantId, loc) {
  const rows = await withTenant(appPool, tenantId, (db) => onHand(db, { variantId }));
  const at = (code) => String(Number(rows.find((r) => r.locationId === loc[code])?.qty ?? '0'));
  return { WH: at('WH-01'), TRANSIT: at('TRANSIT'), BR: at('BR-04') };
}

async function ownerCountsFor(c, tenantId) {
  const one = async (t) => Number((await c.query(`select count(*) n from ${t} where tenant_id = $1`, [tenantId])).rows[0].n);
  return { items: await one('items'), locations: await one('locations'), movements: await one('stock_movements'), requisitions: await one('requisitions') };
}

/** Tenant B: a fresh tenant with one item and one location; it must see NONE of A's rows. */
async function isolationCheck({ ownerUrl, appPool, tenantA, variantA, locA, reqA, ids }) {
  const owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  let tenantB;
  try {
    tenantB = (await owner.query(`insert into tenants (name) values ($1) returning id`, [`e2e-B-${rnd()}`])).rows[0].id;
    ids.push(tenantB);
    await owner.query(
      `insert into app_users (tenant_id, name, name_normalised, username, role, password_hash)
       values ($1, 'B owner', public.normalise_name('B owner'), 'b_owner', 'owner', 'x')`,
      [tenantB],
    );
    // CONTROL: A's data really exists (read with the owner), so "B sees zero" is meaningful.
    const a = await ownerCountsFor(owner, tenantA);
    assert.ok(a.items > 0 && a.locations > 0 && a.movements > 0 && a.requisitions > 0, 'control: tenant A has data to leak');
  } finally {
    await owner.end().catch(() => {});
  }
  await withTenant(appPool, tenantB, (db) => createLocation(db, { code: 'B-WH', nameAr: 'مستودع ب', type: 'warehouse' }));
  const itemB = await withTenant(appPool, tenantB, (db) =>
    createItem(db, { sku: 'BBB-0001', barcode: 'BBB-0001', nameAr: 'صنف ب', family: 'consumable', uom: 'unit', packFactor: 1, costEgp: 1 }),
  );

  const seen = await withTenant(appPool, tenantB, async (db) => {
    const n = async (sql, p = []) => Number((await db.query(sql, p)).rows[0].n);
    return {
      items: await n('select count(*) n from items'),
      itemsOfA: await n('select count(*) n from items where id <> $1 and tenant_id = $2', [itemB.item.id, tenantA]),
      locations: await n('select count(*) n from locations'),
      movements: await n('select count(*) n from stock_movements'),
      requisitions: await n('select count(*) n from requisitions'),
      onHandRows: await n('select count(*) n from on_hand'),
      tenants: await n('select count(*) n from tenants'),
      aVariant: await findVariantById(db, variantA),
      aHistory: await movementHistory(db, variantA),
      aOnHand: await onHand(db, { variantId: variantA }),
      aRequisition: await n('select count(*) n from requisitions where id = $1', [reqA]),
      aLocation: await n('select count(*) n from locations where id = $1', [locA]),
    };
  });
  assert.equal(seen.items, 1, 'tenant B sees only its own item');
  assert.equal(seen.itemsOfA, 0, "tenant B sees none of A's items");
  assert.equal(seen.locations, 1, 'tenant B sees only its own location');
  assert.equal(seen.movements, 0, "tenant B sees none of A's movements");
  assert.equal(seen.requisitions, 0, "tenant B sees none of A's requisitions");
  assert.equal(seen.onHandRows, 0, "tenant B sees none of A's on-hand rows");
  assert.equal(seen.tenants, 1, 'tenant B sees only its own tenant row');
  assert.ok(!seen.aVariant, "A's variant id under B's session returns nothing");
  assert.equal(seen.aHistory.length, 0, "A's variant history under B's session is empty");
  assert.equal(seen.aOnHand.length, 0, "A's variant on-hand under B's session is empty");
  assert.equal(seen.aRequisition + seen.aLocation, 0, "A's requisition/location ids under B's session return nothing");
  return { tenantB };
}

/**
 * The scripted flow + invariant + isolation, in-process, as the non-owner role.
 * `http` (CLI only) = { build: boolean } to add the production-build smoke.
 */
export async function runInProcess({ ownerUrl, appUrl, http = null, log = () => {} }) {
  const appPool = await createAppPool(appUrl); // REFUSES a superuser / BYPASSRLS role
  const ids = [];
  /** @type {{ steps: Array<Record<string, string>>, reasons: string[], cleanup: { rowsLeft: number }, reconciliation: any, http: any, tenantA: string | null }} */
  const out = { steps: [], reasons: [], cleanup: { rowsLeft: -1 }, reconciliation: null, http: null, tenantA: null };
  let failure;
  try {
    const pw = { owner: rnd(10), manager: rnd(10), branch: rnd(10) };
    const seeded = await seedTenant({ ownerUrl, appUrl, name: `e2e-A-${rnd()}`, passwords: pw });
    const tenantA = seeded.tenantId;
    ids.push(tenantA);
    out.tenantA = tenantA;
    const { loc, user } = await loadWorld(appPool, tenantA);
    const manager = user.manager;
    const branch04 = user.branch04;
    assert.ok(manager && branch04 && loc['WH-01'] && loc['BR-04'] && loc.TRANSIT && loc['VENDOR-01'], 'the seed created the users and locations');

    // Every seeded opening balance already has an actor.
    const nullActors = await withTenant(appPool, tenantA, async (db) =>
      Number((await db.query('select count(*) n from stock_movements where actor_user_id is null')).rows[0].n),
    );
    assert.equal(nullActors, 0, 'every seeded opening movement has an actor');

    // A fresh variant, so the numbers below are exact whatever the seed holds.
    const { variant } = await withTenant(appPool, tenantA, (db) =>
      createItem(db, { sku: 'E2E-0001', barcode: 'E2E-0001', nameAr: 'صنف الاختبار الشامل', family: 'consumable', uom: 'unit', packFactor: 1, costEgp: 10 }),
    );
    const V = variant.id;
    const step = async (name, expected) => {
      const b = await balances(appPool, tenantA, V, loc);
      out.steps.push({ step: name, ...b });
      assert.deepEqual(b, expected, `on-hand after ${name}`);
      log(`  ${name.padEnd(8)} WH-01=${b.WH} TRANSIT=${b.TRANSIT} BR-04=${b.BR}`);
    };

    // 1. receive 40 against an expected 40 (manager)
    const receipt = await withTenant(appPool, tenantA, (db) =>
      createReceipt(db, { sourceLocationId: loc['VENDOR-01'], destLocationId: loc['WH-01'], refNo: 'E2E-DN-1', lines: [{ variantId: V, expectedQty: 40 }] }),
    );
    const posted = await withTenant(appPool, tenantA, (db) => postReceipt(db, receipt.id, [{ variantId: V, receivedQty: 40 }], manager));
    assert.equal(posted.shortfalls.length, 0, 'received exactly what was expected');
    assert.equal(posted.duplicateOf, null);
    await step('receipt', { WH: '40', TRANSIT: '0', BR: '0' });

    // 2. branch04 requests 10; manager approves and issues
    const req = await withTenant(appPool, tenantA, (db) =>
      createRequisition(db, { branchLocationId: loc['BR-04'], requestedBy: branch04, lines: [{ variantId: V, requestedQty: 10 }] }),
    );
    await withTenant(appPool, tenantA, (db) => approve(db, req.id, manager));
    await withTenant(appPool, tenantA, (db) => issue(db, req.id, manager, [{ variantId: V, qty: 10 }]));
    await step('issue', { WH: '30', TRANSIT: '10', BR: '0' });

    // 3. branch04 confirms receipt
    await withTenant(appPool, tenantA, (db) => confirmReceipt(db, req.id, branch04, [{ variantId: V, qty: 10 }]));
    await step('confirm', { WH: '30', TRANSIT: '0', BR: '10' });

    // 4. branch04 returns 2
    await withTenant(appPool, tenantA, (db) => returnRequisition(db, req.id, branch04, [{ variantId: V, qty: 2 }]));
    await step('return', { WH: '32', TRANSIT: '0', BR: '8' });

    // 5. manager counts the warehouse and finds 31 (a -1 variance)
    const session = await withTenant(appPool, tenantA, (db) => openCount(db, { locationId: loc['WH-01'], startedBy: manager }));
    await withTenant(appPool, tenantA, (db) => recordCount(db, session.id, [{ variantId: V, countedQty: 31 }]));
    const closed = await withTenant(appPool, tenantA, (db) => closeCount(db, session.id, manager));
    assert.equal(closed.adjustments, 1, 'exactly one adjusting movement for the -1 variance');
    await step('count', { WH: '31', TRANSIT: '0', BR: '8' });

    // The variant's history: exactly these rows, in order, each with an actor.
    const history = (await withTenant(appPool, tenantA, (db) => movementHistory(db, V))).sort((x, y) => (BigInt(x.seq) < BigInt(y.seq) ? -1 : 1));
    out.reasons = history.map((m) => m.reason);
    assert.deepEqual(
      history.map((m) => [m.reason, m.from_location_id, m.to_location_id, fromMilli(toMilli(m.qty))]),
      [
        ['receipt', loc['VENDOR-01'], loc['WH-01'], '40'],
        ['issue_to_branch', loc['WH-01'], loc.TRANSIT, '10'],
        ['issue_to_branch', loc.TRANSIT, loc['BR-04'], '10'],
        ['return_from_branch', loc['BR-04'], loc['WH-01'], '2'],
        ['count_correction', loc['WH-01'], null, '1'],
      ],
      'the movement history of the variant: reasons, legs and quantities in order',
    );
    for (const m of history) assert.ok(m.actor_user_id, `movement ${m.reason} has an actor`);
    assert.deepEqual(
      history.map((m) => m.actor_user_id),
      [manager, manager, branch04, branch04, manager],
      'the actors are the roles that did each step',
    );
    for (let i = 1; i < history.length; i++) assert.ok(BigInt(history[i].seq) > BigInt(history[i - 1].seq), 'seq strictly increases');

    // The conservation invariant, for EVERY variant of the tenant.
    const rec = await reconcileTenant(appPool, tenantA);
    assertReconciled(rec, 'after the flow');
    const mine = rec.rows.find((r) => r.variantId === V);
    assert.equal(mine.systemTotal, '39', '40 received - 1 counted away = 39 in the system (WH 31 + BR-04 8)');
    assert.deepEqual(mine.reasons, { receipt: '40', issue_to_branch: '0', return_from_branch: '0', count_correction: '-1' });
    out.reconciliation = rec;

    // Tenant isolation.
    await isolationCheck({ ownerUrl, appPool, tenantA, variantA: V, locA: loc['BR-04'], reqA: req.id, ids });
    log('  isolation: tenant B sees none of tenant A');

    if (http) {
      out.http = await httpSmoke({ appUrl, appPool, tenantId: tenantA, managerPassword: pw.manager, variantId: V, loc, build: http.build, log });
      const after = await reconcileTenant(appPool, tenantA);
      assertReconciled(after, 'after the HTTP/API smoke');
      assert.equal(after.rows.find((r) => r.variantId === V).systemTotal, '38', 'the API sale took one off the branch');
      out.reconciliation = after;
      out.http.lines.push('conservation invariant re-asserted after the API calls: ok (E2E-0001 system total 38)');
    }
  } catch (err) {
    failure = err;
  } finally {
    await appPool.end().catch(() => {});
    try {
      out.cleanup = await cleanupTenants(ownerUrl, ids);
    } catch (err) {
      failure ??= err;
    }
  }
  if (failure) throw failure;
  assert.equal(out.cleanup.rowsLeft, 0, 'cleanup left rows behind');
  return out;
}

// ---------------------------------------------------------------------------
// HTTP + API smoke against a PRODUCTION BUILD
// ---------------------------------------------------------------------------

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}

function portOpen(port) {
  return new Promise((res) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.on('connect', () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
  });
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGKILL');
}

export async function httpSmoke({ appUrl, appPool, tenantId, managerPassword, variantId, loc, build, log = () => {} }) {
  const lines = [];
  if (build) {
    const r = spawnSync('npx', ['next', 'build'], { cwd: REPO_ROOT, shell: true, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production' } });
    assert.equal(r.status, 0, `next build failed:\n${(String(r.stdout) + String(r.stderr)).split('\n').slice(-12).join('\n')}`);
    lines.push('next build: ok');
  }
  assert.ok(existsSync(join(REPO_ROOT, '.next', 'BUILD_ID')), 'no production build (.next/BUILD_ID)');

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  // The server gets the APP role only: the owner urls are removed from its environment.
  const env = { ...process.env, NODE_ENV: 'production', APP_DATABASE_URL: appUrl, TENANT_ID: tenantId };
  delete env.MIGRATE_DATABASE_URL;
  delete env.DATABASE_URL;
  let serverLog = '';
  const child = spawn(process.execPath, [join(REPO_ROOT, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', String(port)], { cwd: REPO_ROOT, env });
  child.stdout.on('data', (d) => (serverLog += d));
  child.stderr.on('data', (d) => (serverLog += d));
  try {
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`next start exited early:\n${serverLog.slice(-600)}`);
      try {
        if ((await fetch(`${base}/sign-in`)).status < 500) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`next start never became ready:\n${serverLog.slice(-600)}`);
      await new Promise((r) => setTimeout(r, 250));
    }
    lines.push(`next start on a free port (${port}): ready`);

    // Sign in through the REAL server action: the form's own hidden action field.
    const page = await (await fetch(`${base}/sign-in`)).text();
    const actionField = /name="(\$ACTION_ID_[^"]+)"/.exec(page)?.[1];
    assert.ok(actionField, 'the sign-in form carries a server-action field');
    const form = new FormData();
    form.set(actionField, '');
    form.set('username', 'manager');
    form.set('password', managerPassword);
    const signin = await fetch(`${base}/sign-in`, { method: 'POST', body: form, redirect: 'manual' });
    const setCookie = signin.headers.getSetCookie().find((c) => c.startsWith('__Host-session='));
    assert.ok([302, 303, 307].includes(signin.status) && setCookie, `sign-in action must redirect with the session cookie (status ${signin.status})`);
    assert.match(setCookie, /;\s*Secure/i, 'the session cookie is Secure');
    const cookie = setCookie.split(';')[0];
    lines.push(`POST sign-in (server action, manager): ${signin.status} + __Host-session cookie`);

    const get = (path, c = cookie) => fetch(`${base}${path}`, { redirect: 'manual', headers: c ? { cookie: c } : {} });
    for (const path of ['/intake', '/requisitions', '/stock', '/stock/usage', '/reports']) {
      let r = await get(path);
      let hops = '';
      // /stock/usage canonicalises its date window with ONE same-path redirect: follow it (signed in).
      if (r.status === 307 && path === '/stock/usage' && new URL(r.headers.get('location'), base).pathname === path) {
        hops = ' (after its 307 to the default date window)';
        r = await get(new URL(r.headers.get('location'), base).pathname + new URL(r.headers.get('location'), base).search);
      }
      const html = await r.text();
      assert.equal(r.status, 200, `GET ${path}`);
      assert.match(html, /dir="rtl"/, `${path} is right-to-left Arabic`);
      lines.push(`GET ${path}: ${r.status} dir=rtl${hops}`);
    }
    const label = await get(`/api/labels/variant/${variantId}`);
    const svg = await label.text();
    assert.equal(label.status, 200, 'label');
    assert.match(label.headers.get('content-type') ?? '', /image\/svg\+xml/);
    assert.match(svg, /<svg/);
    lines.push(`GET /api/labels/variant/<id>: ${label.status} ${label.headers.get('content-type')}`);
    const anon = await get('/stock', '');
    assert.equal(anon.status, 307, 'no cookie redirects');
    assert.match(anon.headers.get('location') ?? '', /sign-in/);
    lines.push(`GET /stock without a cookie: ${anon.status} -> ${new URL(anon.headers.get('location'), base).pathname}`);

    // The API, with a read+write client token (never printed beyond 4 characters).
    const { token } = await withTenant(appPool, tenantId, (db) => issueClient(db, { name: `e2e-smoke-${rnd(3)}`, scopes: ['read', 'write'] }));
    lines.push(`issued a read+write API client (token ${token.slice(0, 4)}…)`);
    const auth = { authorization: `Bearer ${token}` };
    const on = await fetch(`${base}/api/v1/on-hand`, { headers: auth });
    const onBody = await on.json();
    assert.equal(on.status, 200, 'GET /api/v1/on-hand');
    const rows = onBody.data ?? onBody.items ?? onBody;
    const at = (code) => rows.find((r) => r.variantId === variantId && r.locationCode === code)?.onHand;
    assert.equal(Number(at('WH-01')), 31, 'API on-hand WH-01');
    assert.equal(Number(at('BR-04')), 8, 'API on-hand BR-04');
    lines.push(`GET /api/v1/on-hand: ${on.status} (E2E-0001 WH-01=${Number(at('WH-01'))}, BR-04=${Number(at('BR-04'))} — matches the ledger)`);

    const post = (body, key) =>
      fetch(`${base}/api/v1/movements`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body) });
    const sale = { variantId, qty: '1', reason: 'sale', fromLocationId: loc['BR-04'] };
    const key = `e2e-${rnd(8)}`;
    const s1 = await post(sale, key);
    assert.equal(s1.status, 201, `sale: ${await s1.clone().text()}`);
    lines.push(`POST /api/v1/movements sale (Idempotency-Key): ${s1.status}`);
    const s2 = await post(sale, key);
    assert.equal(s2.status, 200, 'same key again is deduped');
    lines.push(`POST /api/v1/movements same key again: ${s2.status} (deduped)`);
    const s3 = await post({ ...sale, fromLocationId: loc.TRANSIT }, `e2e-${rnd(8)}`);
    assert.equal(s3.status, 422, 'a sale from TRANSIT is refused');
    lines.push(`POST sale from TRANSIT: ${s3.status}`);
    const s4 = await post({ ...sale, qty: '9999' }, `e2e-${rnd(8)}`);
    assert.equal(s4.status, 409, 'a sale of more than on-hand is refused');
    lines.push(`POST sale of more than on-hand: ${s4.status}`);
    const on2 = await (await fetch(`${base}/api/v1/on-hand`, { headers: auth })).json();
    const rows2 = on2.data ?? on2.items ?? on2;
    assert.equal(Number(rows2.find((r) => r.variantId === variantId && r.locationCode === 'BR-04')?.onHand), 7, 'API on-hand after the one sale');
    return { lines };
  } finally {
    killTree(child);
    for (let i = 0; i < 40 && (await portOpen(port)); i++) await new Promise((r) => setTimeout(r, 100));
    const closed = !(await portOpen(port));
    lines.push(`server killed; port ${port} ${closed ? 'CLOSED' : 'STILL OPEN'}`);
    log(lines.at(-1));
    assert.ok(closed, `port ${port} is still open after the server was killed`);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function demoCounts(ownerUrl) {
  const c = new pg.Client({ connectionString: ownerUrl });
  await c.connect();
  try {
    const f = await ownerCountsFor(c, DEMO_TENANT_ID);
    // Every OTHER tenant too: a run must leave all pre-existing tenants exactly as they were.
    const all = async (t) => Number((await c.query(`select count(*) n from ${t}`)).rows[0].n);
    return `items=${f.items} locations=${f.locations} movements=${f.movements} | all tenants: items=${await all('items')} locations=${await all('locations')} movements=${await all('stock_movements')} users=${await all('app_users')}`;
  } finally {
    await c.end();
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const unknown = argv.filter((a) => !['--no-http', '--no-build'].includes(a));
  if (unknown.length) {
    console.error(`unknown option ${unknown[0].slice(0, 40)}\nusage: npm run e2e [-- --no-http] [-- --no-build]`);
    return 2;
  }
  const ownerUrl = process.env.MIGRATE_DATABASE_URL?.trim();
  const appUrl = process.env.APP_DATABASE_URL?.trim();
  if (!ownerUrl || !appUrl) {
    console.error('e2e: MIGRATE_DATABASE_URL (owner, creates/deletes the fresh tenants) and APP_DATABASE_URL (the NON-owner app role) must both be set');
    return 1;
  }
  const log = (s) => console.log(s);
  try {
    const before = await demoCounts(ownerUrl);
    log('e2e: seed -> receive -> request -> issue -> confirm -> return -> count (real writers, app role)');
    const r = await runInProcess({ ownerUrl, appUrl, http: argv.includes('--no-http') ? null : { build: !argv.includes('--no-build') }, log });
    log('\nreconciled totals (on_hand view vs independent ledger sum, per variant):');
    log(formatReconciliation(r.reconciliation));
    log(`\nmovement history of E2E-0001: ${r.reasons.join(' > ')}`);
    if (r.http) {
      log('\nHTTP smoke (production build):');
      for (const l of r.http.lines) log(`  ${l}`);
    }
    log(`\ncleanup: fresh tenants deleted, rows left for their ids: ${r.cleanup.rowsLeft}`);
    const after = await demoCounts(ownerUrl);
    log(`demo tenant ${DEMO_TENANT_ID}: before ${before} | after ${after} | ${before === after ? 'unchanged' : 'CHANGED'}`);
    assert.equal(before, after, 'the demo tenant must be untouched');
    log('e2e: PASS');
    return 0;
  } catch (err) {
    console.error(`e2e: FAIL — ${err instanceof Error ? err.message.split('\n').slice(0, 6).join('\n') : String(err)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
