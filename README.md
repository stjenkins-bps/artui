# artui

A full-screen, k9s-inspired terminal client for Azure resources.

## What it is

`artui` is aimed at the same operating model that makes k9s effective:

- a full-screen terminal UI
- a current context
- a main table view
- a context-and-selection header
- a bottom command bar for `:` commands

Instead of Kubernetes resources and contexts, this project targets Azure subscriptions and Azure resources.

## Current views

The TUI currently supports:

- `:subscriptions` — browse subscriptions and press `Enter` to set Azure context
- `:resource-groups` — browse resource-group scope, including an `all` option
- `:resources` — browse all Azure resources in the current subscription or resource-group scope
- `:virtual-machines` — browse VMs in the active subscription / resource-group context; `Enter` opens basic VM info and `d` opens expanded JSON details in `$VISUAL` / `$EDITOR` in the current terminal

## Current layout

- top header with the current subscription pinned at the top-left, plus resource-group scope, active view, and selected-row details
- an input bar between the header and the main view for `:` commands and `/` search
- main resource table
- footer with k9s-style key hints
- `:` command line

## Prerequisites

- Node.js 20+
- Azure CLI installed
- authenticated Azure session via `az login`

## Install

### Local development

```bash
npm install
```

### From a GitHub release

Each tagged release publishes an installable tarball to the repo's Releases page.

```bash
npm install -g https://github.com/stjenkins-bps/artui/releases/download/vX.Y.Z/artui-X.Y.Z.tgz
```

Then run:

```bash
artui
```

## Run

```bash
npm run dev
```

or:

```bash
npm run build
npm start
```

## Keybindings

- `j` / `k` or `↑` / `↓` — move selection
- `enter` — apply the primary action for the selected row; opens basic VM info in the VM view
- `:` — open command mode with autocomplete suggestions
- `/` — live search/filter the current display as you type
- `tab` in `:` mode — autocomplete the selected command
- `↑` / `↓` in `:` mode — move through command suggestions
- `d` — collect full VM details and open JSON in `$VISUAL` / `$EDITOR` in the current terminal
- `D` — open the same full VM details in artui's scrollable inspector
- `r` — refresh current view
- `:refresh 30` — refresh the active view automatically every 30 seconds
- `:refresh off` / `:refresh on` — disable or enable automatic refresh (15 seconds by default)
- `:refresh status` — show current automatic refresh state
- `?` — open help
- `q` — quit

## Commands

- `:subscriptions`
- `:resource-groups` (`:resource-group`, `:rg`)
- `:resources`
- `:virtual-machines` (`:virtual-machine`, `:vm`)
- `:context`
- `:clear-resource-group`
- `:refresh [5-3600|on|off|status]`
- `:quit`

## Startup flow

- app opens in `subscriptions`
- selecting a subscription immediately opens `resource-groups`
- selecting a resource group (or `all`) immediately opens `resources`

## Notes

The data source is currently the Azure CLI (`az`). artui uses the authenticated Azure CLI session, but subscription selection is held inside artui and does **not** run `az account set` or otherwise alter your global Azure CLI context. The broad `resources` view prefers Azure Resource Graph and automatically falls back to ARM resource listing when Resource Graph is unavailable.

For the terminal VM editor flow, set `$VISUAL` or `$EDITOR` to a terminal editor such as `nvim`, `vim`, `nano`, or `code --wait`. artui temporarily hands the terminal to that editor and restores the TUI after it exits.

## Next steps to get even closer to k9s

- add more resource views like `:vnets`, `:storage-accounts`, `:aks`, `:sql`, `:network-interfaces`
- add row actions and drill-down detail views
- add highlighted/fuzzy search and next/previous match navigation
- add background refresh and local caching
- add an Azure SDK provider alongside the Azure CLI provider
