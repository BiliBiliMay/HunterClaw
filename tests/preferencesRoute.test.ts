import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { GET, PATCH } from "@/app/api/preferences/route";
import { createDefaultApprovalPreferences } from "@/lib/agent/approvalPreferences";

import { createTestHarness } from "@/tests/testHarness";

const harness = createTestHarness("hunterclaw-preferences-route");

before(async () => {
  await harness.setup();
});

after(async () => {
  await harness.teardown();
});

test("GET returns the default approval preference snapshot with stored overrides", async () => {
  await harness.setPreference("approval.browser.click", "true");
  const response = await GET();
  const payload = await response.json();
  const defaults = createDefaultApprovalPreferences();

  assert.equal(response.status, 200);
  assert.equal(payload.preferences["approval.browser.click"], true);
  assert.equal(
    payload.preferences["approval.file.host.read"],
    defaults["approval.file.host.read"],
  );
});

test("PATCH updates approval preferences and returns the merged snapshot", async () => {
  const response = await PATCH(
    new Request("http://localhost/api/preferences", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        preferences: {
          "approval.file.host.read": true,
          "approval.browser.type": true,
        },
      }),
    }),
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.preferences["approval.file.host.read"], true);
  assert.equal(payload.preferences["approval.browser.type"], true);
  assert.equal(payload.preferences["approval.browser.click"], true);
});

test("PATCH rejects unknown approval preference keys", async () => {
  const response = await PATCH(
    new Request("http://localhost/api/preferences", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        preferences: {
          "approval.unknown.key": true,
        },
      }),
    }),
  );
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.match(payload.error, /Unknown approval preference/);
});
