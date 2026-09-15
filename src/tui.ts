import blessed from "blessed";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getVirtualMachineDetails,
  listResourceGroups,
  listResources,
  listSubscriptions,
  listVirtualMachines,
  verifyAzureSession,
} from "./azure-cli.js";
import { KNOWN_COMMANDS, normalizeCommand } from "./commands.js";
import type {
  AppContext,
  AzureResource,
  ResourceViewName,
  ScopeOption,
  Subscription,
  TableModel,
  ViewItem,
  VmPortalDetails,
  VirtualMachine,
} from "./types.js";
import {
  ALL_RESOURCE_GROUPS_SCOPE,
  resourceGroupScope,
  resourceGroupScopeOptions,
  scopeLabel,
} from "./scope.js";
import { truncate } from "./ui.js";

type FocusPane = "table";
type InputMode = "none" | "command" | "search";

type ResourceMenuItem = {
  id: ResourceViewName;
  label: string;
  description: string;
};

const RESOURCE_MENU: ResourceMenuItem[] = [
  { id: "subscriptions", label: "subscriptions", description: "Select Azure subscription context" },
  { id: "resource-groups", label: "resource-groups", description: "Choose a resource-group scope or all" },
  { id: "resources", label: "resources", description: "Browse all Azure resources in the current scope" },
  { id: "virtual-machines", label: "virtual-machines", description: "Inspect VMs in current context" },
];

export class ArtuiApp {
  private readonly screen = blessed.screen({
    smartCSR: true,
    fullUnicode: true,
    title: "artui",
    dockBorders: true,
  });

  private readonly header = blessed.box({
    parent: this.screen,
    top: 0,
    left: 0,
    width: "100%",
    height: 10,
    tags: true,
    border: "line",
    scrollable: true,
    alwaysScroll: true,
    scrollbar: {
      ch: " ",
    },
    style: {
      border: { fg: "cyan" },
    },
  });

  private readonly inputPanel = blessed.box({
    parent: this.screen,
    top: 10,
    left: 0,
    width: "100%",
    height: 1,
    tags: true,
    style: {
      bg: "black",
      fg: "cyan",
    },
  });

  private readonly table = blessed.listtable({
    parent: this.screen,
    top: 11,
    left: 0,
    width: "100%",
    bottom: 1,
    label: " View ",
    border: "line",
    keys: true,
    mouse: true,
    vi: true,
    interactive: true,
    noCellBorders: true,
    style: {
      border: { fg: "cyan" },
      header: { fg: "black", bg: "cyan", bold: true },
      cell: {
        fg: "white",
        selected: { bg: "blue", fg: "white" },
      },
      focus: { border: { fg: "green" } },
    },
    scrollbar: {
      ch: " ",
    },
  });

  private readonly footer = blessed.box({
    parent: this.screen,
    bottom: 0,
    left: 0,
    width: "100%",
    height: 1,
    tags: true,
    style: {
      bg: "blue",
      fg: "white",
    },
  });

  private readonly inputBox = blessed.textbox({
    parent: this.screen,
    top: 10,
    left: 8,
    width: "100%-8",
    height: 1,
    inputOnFocus: true,
    keys: true,
    mouse: true,
    style: {
      bg: "black",
      fg: "cyan",
    },
    hidden: true,
  });

  private readonly commandSuggestions = blessed.list({
    parent: this.screen,
    top: 11,
    left: 0,
    width: "100%",
    height: 6,
    keys: false,
    mouse: false,
    tags: true,
    border: "line",
    hidden: true,
    style: {
      border: { fg: "yellow" },
      item: { fg: "white" },
      selected: { bg: "blue", fg: "white", bold: true },
    },
  });

  private helpModal?: blessed.Widgets.BoxElement;
  private loadingModal?: blessed.Widgets.BoxElement;
  private inspectorModal?: blessed.Widgets.BoxElement;
  private inspectorSearchBox?: blessed.Widgets.TextboxElement;
  private inspectorContent = "";
  private inspectorSearchQuery = "";
  private inspectorSearchMatches: number[] = [];
  private inspectorSearchIndex = 0;
  private inspectorSearchListener?: (ch: string, key: blessed.Widgets.Events.IKeyEventArg) => void;
  private activeView: ResourceViewName = "subscriptions";
  private focusPane: FocusPane = "table";
  private inputMode: InputMode = "none";
  private context: AppContext = { scope: ALL_RESOURCE_GROUPS_SCOPE };
  private baseModel: TableModel<ViewItem> = { headers: ["Loading"], rows: [], items: [], searchTexts: [] };
  private currentItems: ViewItem[] = [];
  private selectedRow = 0;
  private loading = false;
  private lastStatus = "Ready.";
  private loadVersion = 0;
  private searchQuery = "";
  private searchSnapshot = "";
  private commandMatches = KNOWN_COMMANDS;
  private commandMatchIndex = 0;
  private ignoreNextInputCallback = false;
  private liveSearchListener?: (ch: string, key: blessed.Widgets.Events.IKeyEventArg) => void;
  private liveCommandListener?: (ch: string, key: blessed.Widgets.Events.IKeyEventArg) => void;

  async start(): Promise<void> {
    this.bindKeys();
    this.bindEvents();

    await verifyAzureSession();
    await this.loadActiveView({ resetSelection: true });
    this.setFocus("table");
  }

  destroy(): void {
    this.screen.destroy();
  }

  private bindKeys(): void {
    this.screen.key(["C-c", "q"], () => {
      if (this.inputMode !== "none" || this.helpModal || this.loadingModal || this.inspectorModal) {
        return;
      }
      this.destroy();
      process.exit(0);
    });

    this.screen.key([":"], () => {
      if (this.inputMode !== "none" || this.helpModal || this.loadingModal || this.inspectorModal) {
        return;
      }
      this.openCommand();
    });

    this.screen.key(["/"], () => {
      if (this.inputMode !== "none" || this.helpModal || this.inspectorModal) {
        return;
      }
      this.openSearch();
    });

    this.screen.key(["r"], () => {
      if (this.inputMode !== "none" || this.helpModal || this.loadingModal || this.inspectorModal) {
        return;
      }
      void this.loadActiveView();
    });

    this.screen.key(["?", "f1"], () => {
      if (this.inputMode !== "none" || this.loadingModal || this.inspectorModal) {
        return;
      }
      this.openHelp();
    });

    this.screen.key(["escape"], () => {
      if (this.inputMode !== "none") {
        this.closeInput();
        return;
      }

      if (this.helpModal) {
        this.closeHelp();
      }

      if (this.loadingModal) {
        return;
      }

      if (this.inspectorModal) {
        this.closeInspector();
      }
    });
  }

  private bindEvents(): void {
    this.table.on("keypress", (_ch, key) => {
      if (this.inputMode !== "none" || this.helpModal || this.loadingModal || this.inspectorModal) {
        return;
      }

      if (["up", "down", "j", "k", "g", "G", "pageup", "pagedown"].includes(key.name)) {
        setImmediate(() => {
          this.syncSelectedRowFromTable();
          this.renderHeader();
          this.screen.render();
        });
      }
    });

    // listtable consumes some navigation keys internally; bind actions directly
    // to the focused table so they work consistently across terminals.
    this.table.key(["enter", "return"], () => {
      void this.handlePrimaryAction();
    });
    this.table.key(["d"], () => {
      void this.openVmInEditor();
    });
    this.table.key(["D"], () => {
      this.openVmInspector("full");
    });

    this.screen.on("resize", () => {
      this.renderAll();
    });
  }

  private async setActiveView(view: ResourceViewName): Promise<void> {
    if (this.activeView === view) {
      this.renderAll();
      return;
    }

    this.activeView = view;
    this.searchQuery = "";
    this.renderHeader();
    await this.loadActiveView({ resetSelection: true });
  }

  private async loadActiveView(options: { resetSelection?: boolean } = {}): Promise<void> {
    const version = ++this.loadVersion;
    const previousSelectedId = this.getCurrentItemId();

    this.loading = true;
    this.lastStatus = `Loading ${this.activeView}...`;
    this.renderAll();

    try {
      let model: TableModel<ViewItem>;
      switch (this.activeView) {
        case "subscriptions": {
          const items = await listSubscriptions();
          if (version !== this.loadVersion) {
            return;
          }
          model = this.subscriptionsTable(items);
          this.lastStatus = `Loaded ${items.length} subscriptions.`;
          break;
        }
        case "resource-groups": {
          const items = this.context.subscription
            ? await listResourceGroups(this.context.subscription.id)
            : [];
          if (version !== this.loadVersion) {
            return;
          }
          model = this.resourceGroupsTable(resourceGroupScopeOptions(items));
          this.lastStatus = `Loaded ${items.length} resource-group scope options.`;
          break;
        }
        case "resources": {
          const items = await listResources(this.context);
          if (version !== this.loadVersion) {
            return;
          }
          model = this.resourcesTable(items);
          this.lastStatus = `Loaded ${items.length} resources.`;
          break;
        }
        case "virtual-machines": {
          const items = await listVirtualMachines(this.context);
          if (version !== this.loadVersion) {
            return;
          }
          model = this.virtualMachinesTable(items);
          this.lastStatus = `Loaded ${items.length} virtual machines.`;
          break;
        }
      }

      this.baseModel = model;
      this.applyCurrentFilter(options.resetSelection, previousSelectedId);
    } catch (error) {
      if (version !== this.loadVersion) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.baseModel = { headers: ["Error"], rows: [], items: [], searchTexts: [] };
      this.currentItems = [];
      this.selectedRow = 0;
      this.table.setLabel(` ${this.activeView} `);
      this.table.setData([["Error"], [message]]);
      this.lastStatus = message;
    } finally {
      if (version === this.loadVersion) {
        this.loading = false;
        this.renderAll();
      }
    }
  }

  private applyCurrentFilter(resetSelection = false, previousSelectedId?: string): void {
    const filteredRows: string[][] = [];
    const filteredItems: ViewItem[] = [];

    for (let index = 0; index < this.baseModel.items.length; index += 1) {
      const item = this.baseModel.items[index];
      const row = this.baseModel.rows[index];
      const searchText = this.baseModel.searchTexts[index] ?? row.join(" ");
      if (this.matchesSearch(searchText)) {
        filteredItems.push(item);
        filteredRows.push(row);
      }
    }

    this.currentItems = filteredItems;
    this.table.setLabel(this.tableLabel());
    this.table.setData([this.baseModel.headers, ...filteredRows]);

    if (filteredItems.length === 0) {
      this.selectedRow = 0;
      this.table.select(0);
      this.renderHeader();
      return;
    }

    if (resetSelection) {
      this.selectedRow = 0;
    } else if (previousSelectedId) {
      const nextIndex = filteredItems.findIndex((item) => this.getItemId(item) === previousSelectedId);
      this.selectedRow = nextIndex >= 0 ? nextIndex : Math.min(this.selectedRow, filteredItems.length - 1);
    } else {
      this.selectedRow = Math.min(this.selectedRow, filteredItems.length - 1);
    }

    this.table.select(this.selectedRow + 1);
    this.renderHeader();
  }

  private matchesSearch(searchText: string): boolean {
    if (!this.searchQuery) {
      return true;
    }

    const needle = this.searchQuery.toLowerCase();
    return searchText.toLowerCase().includes(needle);
  }

  private subscriptionsTable(items: Subscription[]): TableModel<Subscription> {
    return {
      headers: ["", "Name", "State", "Tenant", "Subscription ID"],
      items,
      rows: items.map((item) => [
        this.context.subscription?.id === item.id ? "●" : item.isDefault ? "◦" : "",
        truncate(item.name, 28),
        truncate(item.state, 14),
        truncate(item.tenantId, 36),
        truncate(item.id, 36),
      ]),
      searchTexts: items.map((item) => [item.name, item.state, item.tenantId, item.id].join(" ")),
    };
  }

  private resourceGroupsTable(items: ScopeOption[]): TableModel<ScopeOption> {
    return {
      headers: ["", "Scope", "Location", "Tags", "Resource Group ID"],
      items,
      rows: items.map((item) => [
        this.isSelectedResourceGroup(item) ? "●" : "",
        truncate(item.name, 30),
        truncate(item.location, 18),
        String(Object.keys(item.tags ?? {}).length),
        truncate(item.id, 48),
      ]),
      searchTexts: items.map((item) =>
        [item.name, item.location, item.id, Object.keys(item.tags ?? {}).join(" ")].join(" "),
      ),
    };
  }

  private resourcesTable(items: AzureResource[]): TableModel<AzureResource> {
    return {
      headers: ["Name", "Type", "Resource Group", "Location", "Kind"],
      items,
      rows: items.map((item) => [
        truncate(item.name, 28),
        truncate(item.type, 42),
        truncate(item.resourceGroup, 24),
        truncate(item.location, 16),
        truncate(item.kind, 20),
      ]),
      searchTexts: items.map((item) =>
        [
          item.name,
          item.type,
          item.resourceGroup,
          item.location ?? "",
          item.kind ?? "",
          item.id,
          item.subscriptionId ?? "",
        ].join(" "),
      ),
    };
  }

  private virtualMachinesTable(items: VirtualMachine[]): TableModel<VirtualMachine> {
    return {
      headers: ["Name", "Resource Group", "Location", "Size", "OS", "Power"],
      items,
      rows: items.map((item) => [
        truncate(item.name, 28),
        truncate(item.resourceGroup, 26),
        truncate(item.location, 18),
        truncate(item.vmSize, 18),
        truncate(item.osType, 10),
        truncate(item.powerState, 18),
      ]),
      searchTexts: items.map((item) =>
        [
          item.name,
          item.resourceGroup,
          item.location,
          item.vmSize ?? "",
          item.osType ?? "",
          item.powerState ?? "",
          item.provisioningState ?? "",
          item.id,
        ].join(" "),
      ),
    };
  }

  private async handlePrimaryAction(): Promise<void> {
    const item = this.currentItems[this.selectedRow];
    if (!item) {
      return;
    }

    if (this.activeView === "subscriptions") {
      const subscription = item as Subscription;
      this.context.subscription = subscription;
      this.context.scope = ALL_RESOURCE_GROUPS_SCOPE;
      this.searchQuery = "";
      this.lastStatus = `Subscription context set to ${subscription.name}. Choose a resource-group scope.`;
      await this.setActiveView("resource-groups");
      return;
    }

    if (this.activeView === "resource-groups") {
      const scopeOption = item as ScopeOption;
      this.context.scope =
        scopeOption.kind === "resource-group"
          ? resourceGroupScope(scopeOption.resourceGroup)
          : ALL_RESOURCE_GROUPS_SCOPE;
      this.searchQuery = "";
      this.lastStatus =
        scopeOption.kind === "resource-group"
          ? `Resource-group scope set to ${scopeOption.name}.`
          : "Scope set to all resource groups.";
      await this.setActiveView("resources");
      return;
    }

    if (this.activeView === "virtual-machines") {
      this.openVmInspector("basic");
      return;
    }

    if (this.activeView === "resources") {
      this.lastStatus = `Inspecting ${this.getItemLabel(item)}.`;
      this.renderAll();
    }
  }

  private openCommand(): void {
    this.openInput("command", "");
  }

  private openSearch(): void {
    this.searchSnapshot = this.searchQuery;
    this.openInput("search", this.searchQuery);
  }

  private openInput(mode: Exclude<InputMode, "none">, initialValue: string): void {
    this.inputMode = mode;
    this.inputBox.setValue(initialValue);
    this.inputBox.show();
    this.inputBox.focus();

    if (mode === "search") {
      this.attachLiveSearch();
      this.applySearch(initialValue, false);
    }

    if (mode === "command") {
      this.attachLiveCommand();
      this.updateCommandSuggestions(initialValue);
    }

    this.screen.render();

    this.inputBox.readInput((error, value) => {
      if (this.ignoreNextInputCallback) {
        this.ignoreNextInputCallback = false;
        return;
      }

      const message = error instanceof Error ? error.message : "";
      const activeMode = this.inputMode;
      const canceled = message.toLowerCase().includes("canceled") || message.toLowerCase().includes("escape");
      this.closeInput();

      if (canceled) {
        if (activeMode === "search") {
          this.applySearch(`/${this.searchSnapshot}`);
          this.lastStatus = this.searchSnapshot
            ? `Restored /${this.searchSnapshot} in ${this.activeView}.`
            : `Cleared search for ${this.activeView}.`;
          this.renderAll();
        }
        return;
      }

      if (activeMode === "command") {
        const command = this.resolveCommandSubmission(value ?? "");
        if (!command) {
          return;
        }
        void this.executeCommand(command);
        return;
      }

      if (activeMode === "search") {
        this.applySearch(value ?? "");
      }
    });
  }

  private closeInput(): void {
    this.detachLiveSearch();
    this.detachLiveCommand();
    this.commandSuggestions.hide();
    this.inputMode = "none";
    this.inputBox.hide();
    this.setFocus(this.focusPane);
    this.screen.render();
  }

  private applySearch(raw: string, updateStatus = true): void {
    const query = raw.replace(/^\//, "").trim();
    this.searchQuery = query;
    this.selectedRow = 0;
    this.applyCurrentFilter(true);

    if (updateStatus) {
      if (query) {
        this.lastStatus = `Applied /${query} to ${this.activeView}. ${this.currentItems.length} match(es).`;
      } else {
        this.lastStatus = `Cleared search for ${this.activeView}.`;
      }
    }

    this.renderAll();
  }

  private attachLiveSearch(): void {
    this.detachLiveSearch();

    this.liveSearchListener = () => {
      if (this.inputMode !== "search") {
        return;
      }

      setImmediate(() => {
        if (this.inputMode !== "search") {
          return;
        }

        const value = this.inputBox.getValue() ?? "";
        this.applySearch(value, false);
        const query = value.replace(/^\//, "").trim();
        this.lastStatus = query
          ? `Filtering ${this.activeView} by /${query}. ${this.currentItems.length} match(es).`
          : `Filtering cleared for ${this.activeView}.`;
        this.renderAll();
      });
    };

    this.inputBox.on("keypress", this.liveSearchListener);
  }

  private detachLiveSearch(): void {
    if (!this.liveSearchListener) {
      return;
    }

    this.inputBox.off("keypress", this.liveSearchListener);
    this.liveSearchListener = undefined;
  }

  private attachLiveCommand(): void {
    this.detachLiveCommand();

    this.liveCommandListener = (_ch, key) => {
      if (this.inputMode !== "command") {
        return;
      }

      if (key.name === "tab") {
        setImmediate(() => this.acceptCommandSuggestion());
        return;
      }

      if (key.name === "up") {
        setImmediate(() => this.moveCommandSuggestion(-1));
        return;
      }

      if (key.name === "down") {
        setImmediate(() => this.moveCommandSuggestion(1));
        return;
      }

      if (key.name === "enter" || key.name === "return") {
        setImmediate(() => this.submitCommandFromInput());
        return;
      }

      setImmediate(() => {
        if (this.inputMode !== "command") {
          return;
        }

        this.updateCommandSuggestions(this.inputBox.getValue() ?? "");
      });
    };

    this.inputBox.on("keypress", this.liveCommandListener);
  }

  private detachLiveCommand(): void {
    if (!this.liveCommandListener) {
      return;
    }

    this.inputBox.off("keypress", this.liveCommandListener);
    this.liveCommandListener = undefined;
  }

  private updateCommandSuggestions(raw: string): void {
    const input = normalizeCommand(raw);
    const [commandToken] = input.split(/\s+/, 1);
    const hasArgs = input.trim().includes(" ");

    this.commandMatches = hasArgs
      ? KNOWN_COMMANDS
      : KNOWN_COMMANDS.filter((command) => command.name.startsWith(commandToken || ":"));

    if (this.commandMatches.length === 0) {
      this.commandMatchIndex = 0;
      this.commandSuggestions.hide();
      this.lastStatus = `No command matches ${input || ":"}`;
      this.renderAll();
      return;
    }

    this.commandMatchIndex = Math.min(this.commandMatchIndex, this.commandMatches.length - 1);
    this.commandSuggestions.setItems(
      this.commandMatches.map(
        (command) => `${command.name} {gray-fg}${this.escapeTags(command.description)}{/}`,
      ),
    );
    this.commandSuggestions.select(this.commandMatchIndex);
    this.commandSuggestions.show();
    this.lastStatus = `Command mode — ${this.commandMatches.length} match(es). Tab to autocomplete.`;
    this.renderAll();
  }

  private moveCommandSuggestion(direction: 1 | -1): void {
    if (this.commandMatches.length === 0) {
      return;
    }

    this.commandMatchIndex =
      (this.commandMatchIndex + direction + this.commandMatches.length) % this.commandMatches.length;
    this.commandSuggestions.select(this.commandMatchIndex);
    this.lastStatus = `Command mode — ${this.commandMatches[this.commandMatchIndex]?.name}`;
    this.screen.render();
  }

  private acceptCommandSuggestion(): void {
    const suggestion = this.commandMatches[this.commandMatchIndex];
    if (!suggestion) {
      return;
    }

    const current = this.inputBox.getValue() ?? "";
    const normalized = normalizeCommand(current);
    const parts = normalized.trimStart().split(/\s+/);
    const rest = parts.length > 1 ? ` ${parts.slice(1).join(" ")}` : "";
    const nextValue = `${suggestion.name}${rest}`.replace(/^:/, "");
    this.inputBox.setValue(nextValue);
    this.updateCommandSuggestions(nextValue);
    this.screen.render();
  }

  private submitCommandFromInput(): void {
    if (this.inputMode !== "command") {
      return;
    }

    const command = this.resolveCommandSubmission(this.inputBox.getValue() ?? "");
    if (!command) {
      return;
    }

    this.ignoreNextInputCallback = true;
    this.closeInput();
    void this.executeCommand(command);
  }

  private resolveCommandSubmission(raw: string): string {
    const normalized = normalizeCommand(raw);
    const trimmed = normalized.trim();
    if (!trimmed) {
      return "";
    }

    const parts = trimmed.split(/\s+/);
    const commandToken = parts[0];
    const exact = KNOWN_COMMANDS.find((command) => command.name === commandToken);
    if (exact) {
      return trimmed;
    }

    const matches = KNOWN_COMMANDS.filter((command) => command.name.startsWith(commandToken));
    if (matches.length === 1) {
      return [matches[0].name, ...parts.slice(1)].join(" ");
    }

    const selected = this.commandMatches[this.commandMatchIndex];
    if (selected && selected.name.startsWith(commandToken)) {
      return [selected.name, ...parts.slice(1)].join(" ");
    }

    return trimmed;
  }

  private async executeCommand(raw: string): Promise<void> {
    const [command] = raw.trim().split(/\s+/);
    const name = command.replace(/^:/, "");

    switch (name) {
      case "help":
        this.openHelp();
        return;
      case "context":
        this.lastStatus = `subscription=${this.context.subscription?.name ?? "none"} resourceGroup=${scopeLabel(this.context.scope)}`;
        this.renderAll();
        return;
      case "subscriptions":
      case "subs":
        await this.setActiveView("subscriptions");
        return;
      case "resource-groups":
      case "resource-group":
      case "rgs":
      case "rg":
        await this.setActiveView("resource-groups");
        return;
      case "resources":
      case "res":
        await this.setActiveView("resources");
        return;
      case "virtual-machines":
      case "virtual-machine":
      case "vms":
      case "vm":
        await this.setActiveView("virtual-machines");
        return;
      case "clear-resource-group":
      case "crg":
        this.context.scope = ALL_RESOURCE_GROUPS_SCOPE;
        this.lastStatus = "Scope set to all resource groups.";
        await this.setActiveView("resources");
        return;
      case "refresh":
      case "reload":
        await this.loadActiveView();
        return;
      case "quit":
      case "q":
      case "exit":
        this.destroy();
        process.exit(0);
        return;
      default:
        this.lastStatus = `Unknown command: ${raw}`;
        this.renderAll();
    }
  }

  private openHelp(): void {
    if (this.helpModal) {
      return;
    }

    this.helpModal = blessed.box({
      parent: this.screen,
      top: "center",
      left: "center",
      width: "72%",
      height: "72%",
      label: " Help ",
      tags: true,
      border: "line",
      keys: true,
      mouse: true,
      vi: true,
      scrollable: true,
      alwaysScroll: true,
      padding: { left: 1, right: 1 },
      content: this.helpText(),
      style: {
        bg: "black",
        fg: "white",
        border: { fg: "yellow" },
      },
      scrollbar: {
        ch: " ",
      },
    });

    this.helpModal.key(["q", "escape", "enter"], () => this.closeHelp());
    this.helpModal.focus();
    this.screen.render();
  }

  private closeHelp(): void {
    if (!this.helpModal) {
      return;
    }

    this.helpModal.destroy();
    this.helpModal = undefined;
    this.setFocus(this.focusPane);
    this.screen.render();
  }

  private openVmInspector(mode: "basic" | "full"): void {
    if (this.activeView !== "virtual-machines") {
      this.lastStatus = "Full details are currently available from the virtual-machines view.";
      this.renderAll();
      return;
    }

    const selected = this.currentItems[this.selectedRow];
    if (!selected || !("vmSize" in selected)) {
      return;
    }

    this.closeInspector();
    const vm = selected as VirtualMachine;
    const content =
      mode === "basic"
        ? this.basicVmDetails(vm)
        : "Loading VM resource, runtime, disks, network interfaces, public IPs, and extensions...";
    this.inspectorContent = content;
    this.inspectorSearchQuery = "";
    this.inspectorSearchMatches = [];
    this.inspectorSearchIndex = 0;
    this.inspectorModal = blessed.box({
      parent: this.screen,
      top: "center",
      left: "center",
      width: "78%",
      height: "78%",
      label: mode === "basic" ? " VM Info " : " VM Full Details ",
      tags: mode === "basic",
      border: "line",
      keys: true,
      mouse: true,
      vi: true,
      scrollable: true,
      alwaysScroll: true,
      padding: { left: 1, right: 1 },
      content,
      style: {
        bg: "black",
        fg: "white",
        border: { fg: "#0078D4" },
      },
      scrollbar: { ch: " " },
    });

    this.inspectorModal.key(["q", "escape"], () => this.closeInspector());
    this.inspectorModal.key(["/"], () => this.openInspectorSearch());
    this.inspectorModal.key(["n"], () => this.moveInspectorSearch(1));
    this.inspectorModal.key(["N"], () => this.moveInspectorSearch(-1));
    if (mode === "basic") {
      this.inspectorModal.key(["d"], () => void this.openVmInEditor());
      this.inspectorModal.key(["D"], () => this.openVmInspector("full"));
    }
    this.inspectorModal.focus();
    this.screen.render();

    if (mode === "full") {
      void getVirtualMachineDetails(this.context, vm)
        .then((details) => {
          if (!this.inspectorModal) return;
          this.inspectorContent = this.fullVmDetails(details);
          this.inspectorModal.setContent(this.inspectorContent);
          this.screen.render();
        })
        .catch((error) => {
          if (!this.inspectorModal) return;
          const message = error instanceof Error ? error.message : String(error);
          this.inspectorContent = `Unable to load full VM details.\n\n${message}`;
          this.inspectorModal.setContent(this.inspectorContent);
          this.screen.render();
        });
    }
  }

  private closeInspector(): void {
    if (!this.inspectorModal) {
      return;
    }

    this.closeInspectorSearch();
    this.inspectorModal.destroy();
    this.inspectorModal = undefined;
    this.inspectorContent = "";
    this.inspectorSearchQuery = "";
    this.inspectorSearchMatches = [];
    this.setFocus(this.focusPane);
  }

  private openInspectorSearch(): void {
    if (!this.inspectorModal || this.inspectorSearchBox) return;

    this.inspectorSearchBox = blessed.textbox({
      parent: this.inspectorModal,
      bottom: 0,
      left: 0,
      width: "100%",
      height: 1,
      inputOnFocus: true,
      keys: true,
      style: { bg: "black", fg: "yellow" },
    });
    this.inspectorSearchBox.setValue(`/${this.inspectorSearchQuery}`);
    this.inspectorSearchBox.focus();

    this.inspectorSearchListener = () => {
      setImmediate(() => {
        if (!this.inspectorSearchBox) return;
        this.applyInspectorSearch(this.inspectorSearchBox.getValue() ?? "");
      });
    };
    this.inspectorSearchBox.on("keypress", this.inspectorSearchListener);
    this.inspectorSearchBox.readInput((_error, value) => {
      this.applyInspectorSearch(value ?? "");
      this.closeInspectorSearch();
      this.inspectorModal?.focus();
      this.screen.render();
    });
    this.screen.render();
  }

  private closeInspectorSearch(): void {
    if (!this.inspectorSearchBox) return;
    if (this.inspectorSearchListener) this.inspectorSearchBox.off("keypress", this.inspectorSearchListener);
    this.inspectorSearchBox.destroy();
    this.inspectorSearchBox = undefined;
    this.inspectorSearchListener = undefined;
  }

  private applyInspectorSearch(raw: string): void {
    if (!this.inspectorModal) return;
    this.inspectorSearchQuery = raw.replace(/^\//, "").trim();
    const needle = this.inspectorSearchQuery.toLowerCase();
    this.inspectorSearchMatches = !needle
      ? []
      : this.inspectorContent
          .split("\n")
          .flatMap((line, index) => (line.toLowerCase().includes(needle) ? [index] : []));
    this.inspectorSearchIndex = 0;
    this.renderInspectorSearchPosition();
  }

  private moveInspectorSearch(direction: 1 | -1): void {
    if (!this.inspectorModal || this.inspectorSearchMatches.length === 0) return;
    this.inspectorSearchIndex =
      (this.inspectorSearchIndex + direction + this.inspectorSearchMatches.length) %
      this.inspectorSearchMatches.length;
    this.renderInspectorSearchPosition();
  }

  private renderInspectorSearchPosition(): void {
    if (!this.inspectorModal) return;
    const matchCount = this.inspectorSearchMatches.length;
    const label = this.inspectorSearchQuery
      ? ` VM Full Details · /${this.inspectorSearchQuery} ${matchCount ? `${this.inspectorSearchIndex + 1}/${matchCount}` : "no matches"} `
      : " VM Full Details ";
    this.inspectorModal.setLabel(label);
    if (matchCount)
      this.inspectorModal.setScroll(Math.max(0, this.inspectorSearchMatches[this.inspectorSearchIndex] - 2));
    this.screen.render();
  }

  private basicVmDetails(vm: VirtualMachine): string {
    return [
      `{bold}${this.escapeTags(vm.name)}{/}`,
      "",
      `{#0078D4-fg}Resource group:{/} ${this.escapeTags(vm.resourceGroup)}`,
      `{#0078D4-fg}Location:{/}       ${this.escapeTags(vm.location)}`,
      `{#0078D4-fg}Size:{/}           ${this.escapeTags(vm.vmSize ?? "-")}`,
      `{#0078D4-fg}Operating system:{/} ${this.escapeTags(vm.osType ?? "-")}`,
      `{#0078D4-fg}Power state:{/}    ${this.escapeTags(vm.powerState ?? "-")}`,
      `{#0078D4-fg}Provisioning:{/}    ${this.escapeTags(vm.provisioningState ?? "-")}`,
      `{#0078D4-fg}Resource ID:{/}     ${this.escapeTags(vm.id)}`,
      "",
      "Press d to open expanded JSON details in $VISUAL/$EDITOR in this terminal. Press D for the in-TUI full-details view. Press Esc or q to close.",
    ].join("\n");
  }

  private async openVmInEditor(): Promise<void> {
    if (this.activeView !== "virtual-machines") {
      this.lastStatus = "VM details can only be opened from the virtual-machines view.";
      this.renderAll();
      return;
    }

    const selected = this.currentItems[this.selectedRow];
    if (!selected || !("vmSize" in selected)) {
      this.lastStatus = "Select a virtual machine first.";
      this.renderAll();
      return;
    }

    const editor = process.env.VISUAL || process.env.EDITOR;
    if (!editor) {
      this.lastStatus =
        "Set $VISUAL or $EDITOR (for example: export EDITOR=nvim) to open VM details in this terminal.";
      this.renderAll();
      return;
    }

    const vm = selected as VirtualMachine;
    this.lastStatus = `Collecting full details for ${vm.name}...`;
    this.openLoadingModal(vm.name);

    try {
      const details = await getVirtualMachineDetails(this.context, vm, (message) =>
        this.updateLoadingModal(message),
      );
      this.updateLoadingModal("Writing the collected VM details to a temporary JSON file...");
      const directory = await mkdtemp(join(tmpdir(), "artui-vm-"));
      const filename = `${vm.name.replace(/[^a-zA-Z0-9._-]/g, "_") || "virtual-machine"}.json`;
      const detailFile = join(directory, filename);
      await writeFile(detailFile, `${JSON.stringify(details, null, 2)}\n`, "utf8");

      const quotedPath = `"${detailFile.replaceAll('"', '\\"')}"`;
      this.updateLoadingModal(`Opening $VISUAL/$EDITOR in this terminal: ${editor}`);
      this.closeLoadingModal();
      await this.openTerminalEditor(editor, quotedPath);
      this.lastStatus = `Closed ${editor}. VM details remain at ${detailFile}`;
    } catch (error) {
      this.lastStatus = error instanceof Error ? error.message : String(error);
    } finally {
      this.closeLoadingModal();
    }

    this.renderAll();
  }

  private openTerminalEditor(editor: string, quotedPath: string): void {
    const screen = this.screen as unknown as { enter: () => void; leave: () => void };
    // Blessed must completely surrender its alternate screen and input stream before
    // a terminal editor takes over; otherwise its key handlers can consume editor input.
    screen.leave();
    this.screen.program.flush();
    process.stdout.write("\u001b[?1049l\u001b[?25h");
    process.stdin.pause();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }

    try {
      // This must be synchronous: while an editor owns this terminal, artui cannot
      // continue processing keyboard events or redraw its own alternate screen.
      const result = spawnSync(`${editor} ${quotedPath}`, {
        shell: true,
        stdio: "inherit",
      });
      if (result.error) {
        throw result.error;
      }
      if (result.status !== 0) {
        throw new Error(`${editor} exited with status ${result.status ?? "unknown"}.`);
      }
    } finally {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }
      process.stdin.resume();
      screen.enter();
      this.screen.render();
    }
  }

  private openLoadingModal(vmName: string): void {
    this.closeLoadingModal();
    this.loadingModal = blessed.box({
      parent: this.screen,
      top: "center",
      left: "center",
      width: "64%",
      height: 7,
      label: " Collecting VM Details ",
      border: "line",
      align: "center",
      valign: "middle",
      content: `Collecting Azure portal-style details for ${vmName}...\n\nVM resource · runtime state · extensions · disks · network · public IPs`,
      style: {
        bg: "black",
        fg: "white",
        border: { fg: "#0078D4" },
      },
    });
    this.loadingModal.focus();
    this.screen.render();
  }

  private updateLoadingModal(message: string): void {
    if (!this.loadingModal) return;
    this.loadingModal.setContent(message);
    this.screen.render();
  }

  private closeLoadingModal(): void {
    if (!this.loadingModal) return;
    this.loadingModal.destroy();
    this.loadingModal = undefined;
    this.table.focus();
  }

  private fullVmDetails(details: VmPortalDetails): string {
    const section = (title: string, value: unknown): string =>
      ["=".repeat(88), title, "=".repeat(88), JSON.stringify(value, null, 2), ""].join("\n");

    return [
      "VM Full Details",
      "Azure portal-equivalent data collected from the VM, instance view, extensions, disks, NICs, and public IP resources.",
      "Sensitive data may be present in tags or VM configuration. Press Esc or q to close.",
      "",
      section("Virtual machine resource and configuration", details.resource),
      section("Runtime instance view", details.instanceView),
      section("VM extensions and applications", details.extensions),
      section("Managed OS and data disks", details.managedDisks),
      section("Network interfaces and IP configurations", details.networkInterfaces),
      section("Public IP addresses", details.publicIps),
    ].join("\n");
  }

  private helpText(): string {
    return [
      "{bold}artui{/} is a k9s-style Azure resource explorer.",
      "",
      "{bold}Colon commands{/}",
      "  :subscriptions      open subscription selection view",
      "  :resource-groups    open resource-group scope view",
      "  :resource-group     alias for :resource-groups",
      "  :rg                 alias for :resource-groups",
      "  :resources          open all-resources view",
      "  :virtual-machines   open VM view",
      "  :virtual-machine    alias for :virtual-machines",
      "  :vm                 alias for :virtual-machines",
      "  :context            show active context in status bar",
      "  :clear-resource-group",
      "  :refresh",
      "  :quit",
      "",
      "{bold}Navigation{/}",
      "  j/k or ↑/↓          move selection",
      "  enter               select context / open VM info",
      "  d                   open full VM JSON in $VISUAL/$EDITOR",
      "  D                   open full VM details in artui",
      "  :                   open command line with autocomplete",
      "  /                   search within current display",
      "  r                   refresh current view",
      "  ?                   help",
      "  q                   quit",
      "",
      "{bold}Search{/}",
      "  - Press / and type to filter the current table live.",
      "  - Press / and submit an empty query to clear the filter.",
      "",
      "{bold}Command autocomplete{/}",
      "  - Press : to open command mode and see matching commands.",
      "  - Use Up/Down to move through matches.",
      "  - Use Tab to autocomplete the selected command.",
      "",
      "Press q, Esc, or Enter to close this help window.",
    ].join("\n");
  }

  private setFocus(pane: FocusPane): void {
    this.focusPane = pane;
    this.table.focus();
    this.renderAll();
  }

  private renderAll(): void {
    this.renderHeader();
    this.renderInputPanel();
    this.renderFooter();
    this.screen.render();
  }

  private renderHeader(): void {
    this.syncSelectedRowFromTable();

    const subscription = this.context.subscription?.name ?? "no subscription";
    const scope = scopeLabel(this.context.scope);
    const view = RESOURCE_MENU.find((item) => item.id === this.activeView)?.label ?? this.activeView;
    const selected = this.currentItems[this.selectedRow];
    const selectedLabel = selected ? this.getItemLabel(selected) : "none";
    const search = this.searchQuery ? `/${this.searchQuery}` : "none";
    const action =
      this.activeView === "subscriptions"
        ? "<enter> Select subscription"
        : this.activeView === "resource-groups"
          ? "<enter> Select scope"
          : this.activeView === "virtual-machines"
            ? "<d> Full in editor"
            : "<enter> Inspect resource";
    const art = [
      "     _         _____ _   _ ___ ",
      "    / \\   _ __|_   _| | | |_ _|",
      "   / _ \\ | '__| | | | | | || | ",
      "  / ___ \\| |    | | | |_| || | ",
      " /_/   \\_\\_|    |_|  \\___/|___|",
      "",
      "",
      "",
    ];

    this.header.setContent(
      [
        this.headerRow("Context", `${subscription} [LOCAL]`, "<0> all", art[0]),
        this.headerRow("Subscription", subscription, "<r> Refresh", art[1]),
        this.headerRow("Scope", scope, "<d> Describe", art[2]),
        this.headerRow("View", view, "</> Search", art[3]),
        this.headerRow("Filter", search, "<:> Commands", art[4]),
        this.headerRow("Selected", selectedLabel, action, art[5]),
        this.headerRow("Status", this.lastStatus, "<?> Help", art[6]),
        this.headerRow("", "", "<q> Quit", art[7]),
      ].join("\n"),
    );
    this.header.setScroll(0);
  }

  private headerRow(label: string, value: string, shortcut: string, art: string): string {
    const cleanLabel = this.escapeTags(label);
    const cleanValue = this.escapeTags(truncate(value, 40));
    const rawLeft = cleanLabel ? `${cleanLabel}: ${cleanValue}` : cleanValue;
    const [key = "", ...actionParts] = this.escapeTags(shortcut).split(" ");
    const action = actionParts.join(" ");
    const rawMiddle = `${key} ${action}`.trimEnd();
    const leftPadding = " ".repeat(Math.max(1, 54 - rawLeft.length));
    const middlePadding = " ".repeat(Math.max(1, 30 - rawMiddle.length));
    const left = cleanLabel
      ? `{#0078D4-fg}${cleanLabel}:{/} {white-fg}${cleanValue}{/}${leftPadding}`
      : `${leftPadding}`;
    const middle = `{yellow-fg}${key}{/} {gray-fg}${action}{/}${middlePadding}`;
    return `${left}${middle}{#0078D4-fg}${this.escapeTags(art)}{/}`;
  }

  private renderInputPanel(): void {
    if (this.inputMode === "command") {
      this.inputPanel.setContent("{bold}Input{/} :");
      return;
    }

    if (this.inputMode === "search") {
      this.inputPanel.setContent("{bold}Input{/} /");
      return;
    }

    this.inputPanel.setContent("{bold}Input{/}  : commands   / search");
  }

  private renderFooter(): void {
    const viewInfo = RESOURCE_MENU.find((item) => item.id === this.activeView)?.description ?? "";
    const loading = this.loading ? " | loading" : "";
    const search = this.searchQuery ? ` | /${truncate(this.searchQuery, 24)}` : "";
    const status = truncate(this.lastStatus, 80);
    this.footer.setContent(
      ` j/k move | enter select | / search | : command | r refresh | ? help | q quit | ${viewInfo}${loading}${search} | ${this.escapeTags(status)}`,
    );
  }

  private tableLabel(): string {
    return this.searchQuery ? ` ${this.activeView}  /${this.searchQuery} ` : ` ${this.activeView} `;
  }

  private syncSelectedRowFromTable(): void {
    if (this.currentItems.length === 0) {
      this.selectedRow = 0;
      return;
    }

    const selected = this.getSelectedIndex(this.table);
    if (typeof selected !== "number") {
      return;
    }

    const rowIndex = Math.max(0, selected - 1);
    this.selectedRow = Math.min(rowIndex, this.currentItems.length - 1);
  }

  private getSelectedIndex(widget: blessed.Widgets.ListTableElement): number | undefined {
    const candidate = (widget as unknown as { selected?: number }).selected;
    return typeof candidate === "number" ? candidate : undefined;
  }

  private getCurrentItemId(): string | undefined {
    const item = this.currentItems[this.selectedRow];
    return item ? this.getItemId(item) : undefined;
  }

  private isSelectedResourceGroup(item: ScopeOption): boolean {
    if (item.kind === "all") {
      return this.context.scope.kind === "all";
    }

    return (
      this.context.scope.kind === "resource-group" &&
      this.context.scope.resourceGroup.id === item.resourceGroup.id
    );
  }

  private getItemId(item: ViewItem): string {
    return item.id;
  }

  private getItemLabel(item: ViewItem): string {
    if ("tenantId" in item) {
      return `${item.name} (${item.id})`;
    }

    if ("type" in item) {
      return `${item.name} (${item.type})`;
    }

    if ("resourceGroup" in item) {
      return `${item.name} (${item.resourceGroup})`;
    }

    return item.name;
  }

  private escapeTags(value: string): string {
    return value.replace(/[{}]/g, "");
  }
}
