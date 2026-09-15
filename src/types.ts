export type Subscription = {
  id: string;
  name: string;
  tenantId: string;
  state: string;
  isDefault: boolean;
};

export type ResourceGroup = {
  id: string;
  name: string;
  location: string;
  tags: Record<string, string>;
};

export type ResourceGroupScope = { kind: "all" } | { kind: "resource-group"; resourceGroup: ResourceGroup };

export type ScopeOption =
  | { kind: "all"; id: "__all__"; name: "all"; location: "all locations"; tags: Record<string, string> }
  | {
      kind: "resource-group";
      resourceGroup: ResourceGroup;
      id: string;
      name: string;
      location: string;
      tags: Record<string, string>;
    };

export type AzureResource = {
  id: string;
  name: string;
  type: string;
  kind?: string;
  location?: string;
  resourceGroup: string;
  subscriptionId?: string;
  tags: Record<string, string>;
};

export type VirtualMachine = {
  id: string;
  name: string;
  location: string;
  resourceGroup: string;
  powerState?: string;
  provisioningState?: string;
  vmSize?: string;
  osType?: string;
};

export type VmPortalDetails = {
  resource: Record<string, unknown>;
  instanceView: Record<string, unknown> | { error: string };
  extensions: Record<string, unknown>[] | { error: string };
  networkInterfaces: Record<string, unknown>[] | { error: string };
  publicIps: Record<string, unknown>[] | { error: string };
  managedDisks: Record<string, unknown>[] | { error: string };
};

export type ResourceViewName = "subscriptions" | "resource-groups" | "resources" | "virtual-machines";

export type AppContext = {
  subscription?: Subscription;
  scope: ResourceGroupScope;
};

export type TableModel<T> = {
  headers: string[];
  rows: string[][];
  items: T[];
  searchTexts: string[];
};

export type ViewItem = Subscription | ScopeOption | AzureResource | VirtualMachine;

export type AzureCliErrorKind =
  "not-installed" | "not-authenticated" | "not-authorized" | "command-failed" | "invalid-response";

export class AzureCliError extends Error {
  constructor(
    message: string,
    public readonly kind: AzureCliErrorKind,
    public readonly command?: string,
  ) {
    super(message);
    this.name = "AzureCliError";
  }
}
