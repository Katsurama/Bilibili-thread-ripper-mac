"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const script = fs.readFileSync(path.join(__dirname, "../../install-mac.sh"), "utf8");

test("client-launched maintenance leaves the single relaunch to Terminal", () => {
  assert.match(script, /relaunch_after_action\(\) \{ \[ -z "\$FROM_APP" \] && relaunch; \}/);
  assert.equal((script.match(/relaunch_after_action/g) || []).length, 3);
});
