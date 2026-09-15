import assert from "node:assert/strict";
import test from "node:test";
import { KNOWN_COMMANDS, normalizeCommand } from "./commands.js";

test("normalizes commands with and without a colon", () => {
  assert.equal(normalizeCommand("rg"), ":rg");
  assert.equal(normalizeCommand(":resources"), ":resources");
  assert.equal(normalizeCommand("  vm  "), ":vm");
});

test("resource-group and virtual-machine aliases are discoverable", () => {
  const names = new Set(KNOWN_COMMANDS.map((command) => command.name));
  assert.ok(names.has(":rg"));
  assert.ok(names.has(":resource-group"));
  assert.ok(names.has(":vm"));
  assert.ok(names.has(":virtual-machine"));
});
