import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SESSION_COOKIE, sessionCookieName } from '../../src/auth/cookie.ts';
import {
  ERROR_PARAM,
  SIGNED_IN_REDIRECT,
  SIGN_IN_PATH,
  USERNAME_FIELD,
  failedSignInRedirect,
  sessionCookieOptions,
} from '../../src/app/sign-in/contract.ts';

/**
 * The sign-in action's CONTRACT — the parts a `'use server'` module cannot
 * export for testing, lifted into a plain module it imports.
 *
 * These were named as gaps in review: the cookie's ATTRIBUTES and the
 * redirect-with-reason contract were untested, because the only way to reach
 * them was to run a browser. They are decisions, not plumbing — a session
 * cookie without `httpOnly` is readable by any script on the page, one without
 * `sameSite` rides a cross-site form, and one that is `__Host-` but not
 * `Secure` is REJECTED by the browser (which looks exactly like a failed
 * sign-in).
 */

test('the session cookie is httpOnly, SameSite=Lax, path=/, and expires with the session', () => {
  const expires = new Date(Date.UTC(2026, 0, 15, 12, 0, 0));
  const options = sessionCookieOptions(expires, 'development');

  assert.equal(options.httpOnly, true, 'an XSS must not be able to read the token');
  assert.equal(options.sameSite, 'lax', 'a cross-site form must not carry the token');
  assert.equal(options.path, '/', 'the whole app needs it — and __Host- requires it');
  assert.equal(options.expires, expires, 'the cookie must die with the session it carries');
});

test('the cookie is Secure exactly when its name is __Host-, and neither can disagree', () => {
  // Production: the __Host- name AND Secure, together. A __Host- cookie that is
  // not Secure is rejected by the browser, so the two must move as one.
  assert.equal(sessionCookieName('production'), '__Host-session');
  assert.equal(
    sessionCookieOptions(new Date(0), 'production').secure,
    true,
    'a __Host- cookie must be Secure or the browser drops it',
  );

  // Development serves plain http, where a Secure cookie is dropped too — so
  // the name steps back to the plain one at the same time.
  assert.equal(sessionCookieName('development'), 'session');
  assert.equal(sessionCookieName(undefined), 'session');
  assert.equal(
    sessionCookieOptions(new Date(0), 'development').secure,
    false,
    'a Secure cookie over plain http never comes back',
  );

  // The exported constant IS the resolver for this process — one definition.
  assert.equal(SESSION_COOKIE, sessionCookieName());
});

test('a failed sign-in sends the person back to the form with the reason AND their username', () => {
  assert.equal(SIGNED_IN_REDIRECT, '/', 'a signed-in person lands on the home page');
  assert.equal(SIGN_IN_PATH, '/sign-in');
  assert.equal(ERROR_PARAM, 'error');
  assert.equal(
    USERNAME_FIELD,
    'username',
    'the form field is the username — identity is the assigned username, not a name',
  );

  const invalid = failedSignInRedirect('invalid', 'owner_1');
  assert.equal(invalid, '/sign-in?error=invalid&username=owner_1');
  assert.match(invalid, /^\/sign-in\?/, 'the form lives at /sign-in');

  const locked = failedSignInRedirect('locked', 'owner_1');
  assert.equal(locked, '/sign-in?error=locked&username=owner_1');
  assert.notEqual(invalid, locked, 'the two reasons must be distinguishable by the form');

  // Nothing about the PASSWORD is ever carried in a URL — and the username is
  // encoded, so it can neither break the query string nor smuggle a parameter.
  assert.doesNotMatch(invalid, /password/i);
  assert.equal(failedSignInRedirect('invalid', 'a&b=c'), '/sign-in?error=invalid&username=a%26b%3Dc');

  // A username that is not URL-safe survives a round trip through the query
  // string and comes back byte-identical (the form decodes it with
  // URLSearchParams, so the assertion is about the value, not the escaping).
  const roundTrip = new URL(failedSignInRedirect('invalid', 'أحمد علي'), 'http://app');
  assert.equal(roundTrip.pathname, '/sign-in');
  assert.equal(roundTrip.searchParams.get('error'), 'invalid');
  assert.equal(roundTrip.searchParams.get('username'), 'أحمد علي');
});
