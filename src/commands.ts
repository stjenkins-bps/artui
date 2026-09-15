export type KnownCommand = {
  name: string;
  description: string;
};

export const KNOWN_COMMANDS: KnownCommand[] = [
  { name: ":help", description: "Show help" },
  { name: ":context", description: "Show current subscription/resource-group context" },
  { name: ":subscriptions", description: "Open subscriptions view" },
  { name: ":resource-groups", description: "Open resource groups view" },
  { name: ":resource-group", description: "Alias for :resource-groups" },
  { name: ":rg", description: "Alias for :resource-groups" },
  { name: ":resources", description: "Open all resources view" },
  { name: ":virtual-machines", description: "Open virtual machines view" },
  { name: ":virtual-machine", description: "Alias for :virtual-machines" },
  { name: ":vm", description: "Alias for :virtual-machines" },
  { name: ":clear-resource-group", description: "Clear the resource-group filter" },
  { name: ":refresh", description: "Refresh the current view" },
  { name: ":quit", description: "Quit artui" },
];

export function normalizeCommand(input: string): string {
  const value = input.trim();
  if (!value) {
    return value;
  }

  return value.startsWith(":") ? value : `:${value}`;
}
