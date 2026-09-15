import assert from "node:assert/strict";
import test from "node:test";
import {
  ALL_RESOURCE_GROUPS_SCOPE,
  resourceGroupName,
  resourceGroupScope,
  resourceGroupScopeOptions,
  scopeLabel,
} from "./scope.js";

const resourceGroup = {
  id: "/subscriptions/test/resourceGroups/platform",
  name: "platform",
  location: "eastus",
  tags: { environment: "dev" },
};

test("all scope never produces an Azure resource-group argument", () => {
  assert.equal(resourceGroupName(ALL_RESOURCE_GROUPS_SCOPE), undefined);
  assert.equal(scopeLabel(ALL_RESOURCE_GROUPS_SCOPE), "all");
});

test("resource-group scope returns its Azure resource-group name", () => {
  const scope = resourceGroupScope(resourceGroup);
  assert.equal(resourceGroupName(scope), "platform");
  assert.equal(scopeLabel(scope), "platform");
});

test("scope options contain all before actual resource groups", () => {
  const options = resourceGroupScopeOptions([resourceGroup]);
  assert.deepEqual(
    options.map((option) => option.name),
    ["all", "platform"],
  );
  assert.equal(options[0].kind, "all");
  assert.equal(options[1].kind, "resource-group");
});
