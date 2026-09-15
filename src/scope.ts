import type { ResourceGroup, ResourceGroupScope, ScopeOption } from "./types.js";

export const ALL_RESOURCE_GROUPS_SCOPE: ResourceGroupScope = { kind: "all" };

export function resourceGroupScope(resourceGroup: ResourceGroup): ResourceGroupScope {
  return { kind: "resource-group", resourceGroup };
}

export function resourceGroupName(scope: ResourceGroupScope): string | undefined {
  return scope.kind === "resource-group" ? scope.resourceGroup.name : undefined;
}

export function scopeLabel(scope: ResourceGroupScope): string {
  return scope.kind === "all" ? "all" : scope.resourceGroup.name;
}

export function resourceGroupScopeOptions(resourceGroups: ResourceGroup[]): ScopeOption[] {
  return [
    { kind: "all", id: "__all__", name: "all", location: "all locations", tags: {} },
    ...resourceGroups.map((resourceGroup) => ({
      kind: "resource-group" as const,
      resourceGroup,
      id: resourceGroup.id,
      name: resourceGroup.name,
      location: resourceGroup.location,
      tags: resourceGroup.tags,
    })),
  ];
}
