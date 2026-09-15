import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { resourceGroupName } from "./scope.js";
import type {
  AppContext,
  AzureCliErrorKind,
  AzureResource,
  ResourceGroup,
  Subscription,
  VirtualMachine,
  VmPortalDetails,
} from "./types.js";
import { AzureCliError } from "./types.js";

const execFile = promisify(execFileCallback);
const MAX_BUFFER_BYTES = 25 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => (typeof item === "string" ? [[key, item]] : [])),
  );
}

function errorKind(error: unknown): AzureCliErrorKind {
  const message =
    error instanceof Error
      ? `${error.message} ${(error as NodeJS.ErrnoException).code ?? ""}`.toLowerCase()
      : "";
  if (message.includes("enoent") || message.includes("not recognized") || message.includes("not found"))
    return "not-installed";
  if (message.includes("az login") || message.includes("please run 'az login'")) return "not-authenticated";
  if (
    message.includes("authorizationfailed") ||
    message.includes("does not have authorization") ||
    message.includes("forbidden")
  )
    return "not-authorized";
  return "command-failed";
}

function userError(error: unknown, args: string[]): AzureCliError {
  const message = error instanceof Error ? error.message : String(error);
  const kind = errorKind(error);
  const friendly =
    kind === "not-installed"
      ? "Azure CLI was not found. Install it and make sure `az` is on PATH."
      : kind === "not-authenticated"
        ? "Azure CLI is not authenticated. Run `az login` and restart artui."
        : kind === "not-authorized"
          ? "Azure access was denied for this operation. Check your Azure role assignments."
          : `Azure CLI failed: ${message}`;
  return new AzureCliError(friendly, kind, `az ${args.join(" ")}`);
}

async function azJson<T>(args: string[]): Promise<T> {
  try {
    const { stdout } = await execFile("az", [...args, "--output", "json", "--only-show-errors"], {
      maxBuffer: MAX_BUFFER_BYTES,
      timeout: 60_000,
    });
    return JSON.parse(stdout) as T;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new AzureCliError("Azure CLI returned invalid JSON.", "invalid-response", `az ${args.join(" ")}`);
    }
    throw userError(error, args);
  }
}

function requireArray(value: unknown, command: string): JsonRecord[] {
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new AzureCliError("Azure CLI returned an unexpected response.", "invalid-response", command);
  }
  return value;
}

function mapSubscription(row: JsonRecord): Subscription {
  return {
    id: asString(row.id),
    name: asString(row.name),
    tenantId: asString(row.tenantId),
    state: asString(row.state),
    isDefault: Boolean(row.isDefault),
  };
}

export async function verifyAzureSession(): Promise<void> {
  const account = await azJson<unknown>(["account", "show"]);
  if (!isRecord(account) || !asString(account.id)) {
    throw new AzureCliError(
      "Azure CLI did not return an active subscription.",
      "not-authenticated",
      "az account show",
    );
  }
}

export async function getCurrentSubscription(): Promise<Subscription | undefined> {
  const account = await azJson<unknown>(["account", "show"]);
  if (!isRecord(account)) {
    throw new AzureCliError(
      "Azure CLI returned an unexpected subscription response.",
      "invalid-response",
      "az account show",
    );
  }
  return mapSubscription({ ...account, isDefault: true });
}

export async function listSubscriptions(): Promise<Subscription[]> {
  const rows = requireArray(await azJson<unknown>(["account", "list"]), "az account list");
  return rows
    .map(mapSubscription)
    .filter((subscription) => subscription.id && subscription.name)
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
}

export async function listResourceGroups(subscriptionId: string): Promise<ResourceGroup[]> {
  const rows = requireArray(
    await azJson<unknown>(["group", "list", "--subscription", subscriptionId]),
    "az group list",
  );
  return rows
    .map((row) => ({
      id: asString(row.id),
      name: asString(row.name),
      location: asString(row.location),
      tags: asStringRecord(row.tags),
    }))
    .filter((group) => group.id && group.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function mapResource(row: JsonRecord): AzureResource {
  return {
    id: asString(row.id),
    name: asString(row.name),
    type: asString(row.type),
    kind: asString(row.kind) || undefined,
    location: asString(row.location) || undefined,
    resourceGroup: asString(row.resourceGroup),
    subscriptionId: asString(row.subscriptionId) || undefined,
    tags: asStringRecord(row.tags),
  };
}

async function listResourcesFromResourceGraph(context: AppContext): Promise<AzureResource[]> {
  const query = [
    "Resources",
    `| where subscriptionId =~ '${context.subscription?.id.replaceAll("'", "''")}'`,
    context.scope.kind === "resource-group"
      ? `| where resourceGroup =~ '${context.scope.resourceGroup.name.replaceAll("'", "''")}'`
      : "",
    "| project id, name, type, kind, location, resourceGroup, subscriptionId, tags",
  ]
    .filter(Boolean)
    .join(" ");

  const result = await azJson<unknown>(["graph", "query", "-q", query]);
  if (!isRecord(result)) {
    throw new AzureCliError(
      "Azure Resource Graph returned an unexpected response.",
      "invalid-response",
      "az graph query",
    );
  }
  return requireArray(result.data, "az graph query").map(mapResource);
}

async function listResourcesFromArm(context: AppContext): Promise<AzureResource[]> {
  const args = ["resource", "list", "--subscription", context.subscription!.id];
  const groupName = resourceGroupName(context.scope);
  if (groupName) args.push("--resource-group", groupName);
  const rows = requireArray(await azJson<unknown>(args), `az ${args.join(" ")}`);
  return rows.map(mapResource);
}

export async function listResources(context: AppContext): Promise<AzureResource[]> {
  if (!context.subscription) return [];
  try {
    return await listResourcesFromResourceGraph(context);
  } catch (error) {
    if (error instanceof AzureCliError && error.kind === "not-authenticated") throw error;
    return listResourcesFromArm(context);
  }
}

async function optionalAzJson<T>(args: string[]): Promise<T | { error: string }> {
  try {
    return await azJson<T>(args);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function isErrorResult(value: unknown): value is { error: string } {
  return isRecord(value) && typeof value.error === "string";
}

function resourceIds(value: unknown, property: string): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const nested = isRecord(item[property]) ? item[property] : undefined;
    const id = nested ? asString(nested.id) : asString(item.id);
    return id ? [id] : [];
  });
}

function diskIds(resource: JsonRecord): string[] {
  const storageProfile = isRecord(resource.storageProfile) ? resource.storageProfile : {};
  const disks = [
    storageProfile.osDisk,
    ...(Array.isArray(storageProfile.dataDisks) ? storageProfile.dataDisks : []),
  ];
  return resourceIds(disks, "managedDisk");
}

function publicIpIds(networkInterfaces: JsonRecord[]): string[] {
  return networkInterfaces.flatMap((networkInterface) => {
    const configurations = isRecord(networkInterface.properties)
      ? networkInterface.properties.ipConfigurations
      : undefined;
    return resourceIds(configurations, "publicIPAddress");
  });
}

export async function getVirtualMachineDetails(
  context: AppContext,
  vm: VirtualMachine,
  onProgress?: (message: string) => void,
): Promise<VmPortalDetails> {
  if (!context.subscription) {
    throw new AzureCliError("Select a subscription before viewing VM details.", "not-authenticated");
  }

  const vmArgs = [
    "vm",
    "show",
    "--name",
    vm.name,
    "--resource-group",
    vm.resourceGroup,
    "--subscription",
    context.subscription.id,
    "--show-details",
  ];
  onProgress?.("Loading VM configuration and portal properties...");
  const resource = await azJson<unknown>(vmArgs);
  if (!isRecord(resource)) {
    throw new AzureCliError(
      "Azure CLI returned an unexpected VM response.",
      "invalid-response",
      `az ${vmArgs.join(" ")}`,
    );
  }

  onProgress?.("Loading runtime state and VM extensions...");
  const [instanceView, extensions] = await Promise.all([
    optionalAzJson<unknown>([
      "vm",
      "get-instance-view",
      "--name",
      vm.name,
      "--resource-group",
      vm.resourceGroup,
      "--subscription",
      context.subscription.id,
    ]),
    optionalAzJson<unknown>([
      "vm",
      "extension",
      "list",
      "--vm-name",
      vm.name,
      "--resource-group",
      vm.resourceGroup,
      "--subscription",
      context.subscription.id,
    ]),
  ]);

  onProgress?.("Loading network interfaces and IP configuration...");
  const nicIds = resourceIds(
    isRecord(resource.networkProfile) ? resource.networkProfile.networkInterfaces : undefined,
    "",
  );
  const networkInterfacesResult = await Promise.all(
    nicIds.map((id) =>
      optionalAzJson<unknown>([
        "network",
        "nic",
        "show",
        "--ids",
        id,
        "--subscription",
        context.subscription!.id,
      ]),
    ),
  );
  const networkInterfaces = networkInterfacesResult
    .filter(isRecord)
    .filter((item): item is JsonRecord => !isErrorResult(item));
  const networkError = networkInterfacesResult.find(isErrorResult);

  onProgress?.("Loading associated public IP resources...");
  const publicIpResult = await Promise.all(
    publicIpIds(networkInterfaces).map((id) =>
      optionalAzJson<unknown>([
        "network",
        "public-ip",
        "show",
        "--ids",
        id,
        "--subscription",
        context.subscription!.id,
      ]),
    ),
  );
  const publicIps = publicIpResult
    .filter(isRecord)
    .filter((item): item is JsonRecord => !isErrorResult(item));
  const publicIpError = publicIpResult.find(isErrorResult);

  onProgress?.("Loading OS and data disk resources...");
  const diskResult = await Promise.all(
    diskIds(resource).map((id) =>
      optionalAzJson<unknown>(["disk", "show", "--ids", id, "--subscription", context.subscription!.id]),
    ),
  );
  const managedDisks = diskResult.filter(isRecord).filter((item): item is JsonRecord => !isErrorResult(item));
  const diskError = diskResult.find(isErrorResult);

  return {
    resource,
    instanceView: isRecord(instanceView) ? instanceView : { error: "Unexpected instance-view response." },
    extensions:
      Array.isArray(extensions) && extensions.every(isRecord)
        ? extensions
        : isErrorResult(extensions)
          ? extensions
          : { error: "Unexpected extensions response." },
    networkInterfaces: networkError ? { error: networkError.error } : networkInterfaces,
    publicIps: publicIpError ? { error: publicIpError.error } : publicIps,
    managedDisks: diskError ? { error: diskError.error } : managedDisks,
  };
}

export async function listVirtualMachines(context: AppContext): Promise<VirtualMachine[]> {
  if (!context.subscription) return [];
  const args = ["vm", "list", "-d", "--subscription", context.subscription.id];
  const groupName = resourceGroupName(context.scope);
  if (groupName) args.push("--resource-group", groupName);
  const rows = requireArray(await azJson<unknown>(args), `az ${args.join(" ")}`);

  return rows
    .map((row) => {
      const hardwareProfile = isRecord(row.hardwareProfile) ? row.hardwareProfile : {};
      const storageProfile = isRecord(row.storageProfile) ? row.storageProfile : {};
      const osDisk = isRecord(storageProfile.osDisk) ? storageProfile.osDisk : {};
      return {
        id: asString(row.id),
        name: asString(row.name),
        location: asString(row.location),
        resourceGroup: asString(row.resourceGroup),
        powerState: asString(row.powerState) || undefined,
        provisioningState: asString(row.provisioningState) || undefined,
        vmSize: asString(hardwareProfile.vmSize) || undefined,
        osType: asString(osDisk.osType) || undefined,
      };
    })
    .filter((vm) => vm.id && vm.name)
    .sort((a, b) => a.resourceGroup.localeCompare(b.resourceGroup) || a.name.localeCompare(b.name));
}
