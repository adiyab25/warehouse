import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { Client } from 'pg';

import { sessionCookieName } from '@/modules/auth/domain/cookie';
import { createSession } from '@/modules/auth/index';
import { withTenant } from '@/modules/platform/index';
import { REPO_ROOT, migrateUrl, sqlTestUrl } from '../../harness/sql.ts';
import { cleanupTenants, provisionTenants } from '../../harness/tenants.ts';

/**
 * THE FRONT DOOR, end to end — against a REAL server.
 *
 * Review's finding: there was no gate at all. No middleware/proxy, no caller of
 * `readSession` anywhere in src/app, and `/` was a PRERENDERED STATIC page — so
 * an unauthenticated visitor was served the shell and nothing could tell who was
 * asking.
 *
 * The fix is in two halves and BOTH are tested here, because either alone is
 * insufficient:
 *
 *   * src/proxy.ts redirects a request that carries NO session cookie, before
 *     anything renders. Test: "an unauthenticated request to /".
 *   * src/app/page.tsx resolves the cookie against the database and redirects
 *     when it is not a live session. Test: "a FORGED cookie" — the request HAS a
 *     cookie, so the proxy lets it through, and only the page's own check can
 *     refuse it.
 *
 * This is the only test in the suite that boots the built app (`next start`), so
 * it SKIPS unless a production build is present (`.next/BUILD_ID`). Run
 * `npx next build` first: `npm run ci` does not build, and a fresh clone has no
 * `.next`, so on a bare checkout these four tests report as skipped rather than
 * failing.
 */

const PRODUCTION_BUILD = existsSync(join(REPO_ROOT, '.next', 'BUILD_ID'));
const ENABLED = Boolean(sqlTestUrl() && migrateUrl()) && PRODUCTION_BUILD;

/** The cookie name the SERVER uses — it runs with NODE_ENV=production. */
const COOKIE = sessionCookieName('production');

/** What the home page greets the fixture user with (see tests/harness/tenants.ts). */
const DISPLAY_NAME = 'Owner One';
const USERNAME = 'owner_one';

let child: ChildProcess | undefined;
let client: Client | undefined;
let baseUrl = '';
let tenantId = '';
let userId = '';
let serverLog = '';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

/** Boots `next start` and waits until it answers. */
before(async () => {
  if (!ENABLED) return;

  const { t1, u1 } = await provisionTenants();
  tenantId = t1;
  userId = u1;

  client = new Client({ connectionString: sqlTestUrl()! });
  await client.connect();

  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;

  child = spawn(
    process.execPath,
    [join(REPO_ROOT, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', String(port)],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        // The app must reach the database as the NON-owner role, or RLS would be
        // bypassed and every session read would resolve.
        DATABASE_URL: sqlTestUrl()!,
        TENANT_ID: tenantId,
      },
    },
  );
  child.stdout?.on('data', (chunk: Buffer) => (serverLog += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (serverLog += chunk.toString()));

  const deadline = Date.now() + 60_000;
  let lastError = '';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`next start exited early:\n${serverLog}`);
    try {
      const response = await fetch(`${baseUrl}/sign-in`);
      if (response.status < 500) return;
      lastError = `status ${response.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`next start never became ready (${lastError}):\n${serverLog}`);
});

after(async () => {
  child?.kill();
  await client?.end();
  if (ENABLED) await cleanupTenants();
});

/** A GET that never follows a redirect, so the LOCATION can be asserted. */
function get(path: string, cookie?: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    redirect: 'manual',
    headers: cookie ? { cookie } : {},
  });
}

/** Opens a live session for the fixture user, exactly as sign-in would. */
async function liveSessionToken(): Promise<string> {
  const { token } = await withTenant(client!, tenantId, (db) => createSession(db, { userId }));
  return token;
}

test('an unauthenticated request to / is redirected to the sign-in page', { skip: !ENABLED }, async () => {
  const response = await get('/');

  assert.ok(
    [302, 307, 308].includes(response.status),
    `an unauthenticated GET / must redirect, got ${response.status}`,
  );
  assert.match(
    response.headers.get('location') ?? '',
    /\/sign-in$/,
    'the redirect must target /sign-in',
  );
  assert.doesNotMatch(
    await response.text(),
    new RegExp(DISPLAY_NAME),
    'a redirect must not carry the signed-in content',
  );
});

test('a FORGED cookie passes the edge check and is refused by the page', { skip: !ENABLED }, async () => {
  // The proxy only asks "is there a cookie", so this request reaches the page —
  // and the page resolves it against the database, finds no live session, and
  // redirects. Without the page's own check, ANY cookie value would render the
  // shell for anybody who set one.
  const response = await get('/', `${COOKIE}=this-is-not-a-real-token`);

  assert.ok(
    [302, 307, 308].includes(response.status),
    `a cookie that is not a live session must still redirect, got ${response.status}`,
  );
  assert.match(response.headers.get('location') ?? '', /\/sign-in$/);
  assert.doesNotMatch(await response.text(), new RegExp(DISPLAY_NAME));
});

test('after signing in, / renders — with the DISPLAY NAME, not the username', { skip: !ENABLED }, async () => {
  const token = await liveSessionToken();

  const response = await get('/', `${COOKIE}=${token}`);
  assert.equal(response.status, 200, 'a live session must render the home page');

  const html = await response.text();
  assert.match(html, new RegExp(DISPLAY_NAME), 'the signed-in person must see their display name');
  assert.doesNotMatch(
    html,
    new RegExp(USERNAME),
    'the assigned username is a credential, not a greeting — the name is shown instead',
  );
  assert.match(html, /تسجيل الخروج/, 'the page must offer a way out');
});

test('sign-out clears the session cookie and redirects to the sign-in page', { skip: !ENABLED }, async () => {
  const token = await liveSessionToken();

  const response = await get('/sign-out', `${COOKIE}=${token}`);
  assert.ok(
    [302, 307, 308].includes(response.status),
    `sign-out must redirect, got ${response.status}`,
  );
  assert.match(response.headers.get('location') ?? '', /\/sign-in$/);

  // The clearing SET-COOKIE: the right NAME (which in production is the
  // __Host- one), emptied, expired, and scoped to / — a deletion that omitted
  // the path, or used the development name, would leave the live cookie on the
  // browser and the person still signed in.
  const setCookie = response.headers.get('set-cookie') ?? '';
  assert.match(setCookie, new RegExp(`^${COOKIE}=`), `sign-out must clear ${COOKIE}: ${setCookie}`);
  assert.match(setCookie, /max-age=0/i);
  assert.match(setCookie, /path=\//i);
});
