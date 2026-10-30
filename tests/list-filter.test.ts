import { test } from "node:test";
import assert from "node:assert/strict";
import { parseListFilter, toSearchParams, safeSort } from "../src/lib/list-filter";

test("parseListFilter clamps limit", () => {
  const f = parseListFilter(new URLSearchParams("limit=500"));
  assert.equal(f.limit, 100);
});

test("parseListFilter default limit 25", () => {
  const f = parseListFilter(new URLSearchParams(""));
  assert.equal(f.limit, 25);
});

test("parseListFilter multi-status", () => {
  const f = parseListFilter(new URLSearchParams("status=a,b"));
  assert.deepEqual(f.statuses, ["a", "b"]);
});

test("round trip", () => {
  const f = parseListFilter(new URLSearchParams("q=foo&limit=10"));
  const sp = toSearchParams(f);
  assert.equal(sp.get("q"), "foo");
});

test("safeSort allow-list", () => {
  const f = parseListFilter(new URLSearchParams("sort=evil&dir=asc"));
  const s = safeSort(f, ["name"], "created_at");
  assert.equal(s.column, "created_at");
  assert.equal(s.dir, "asc");
});