import assert from "node:assert/strict";
import test from "node:test";
import { applyIdempotentUpserts } from "../dist/sync-core.mjs";

test("sync snapshot updates are idempotent for equal versions", () => {
  const original = new Map([
    ["person-1", { sourceId: "person-1", sourceVersion: "2026-08-20T09:00:00Z", value: "oud" }],
  ]);
  const once = applyIdempotentUpserts(original, [
    { sourceId: "person-1", sourceVersion: "2026-08-20T10:00:00Z", value: "nieuw" },
  ]);
  const twice = applyIdempotentUpserts(once.next, [
    { sourceId: "person-1", sourceVersion: "2026-08-20T10:00:00Z", value: "nieuw" },
  ]);

  assert.equal(once.changed, 1);
  assert.equal(twice.changed, 0);
  assert.equal(twice.skipped, 1);
  assert.equal(twice.next.get("person-1").value, "nieuw");
});