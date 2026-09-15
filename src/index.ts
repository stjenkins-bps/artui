#!/usr/bin/env node

import { ArtuiApp } from "./tui.js";

function printUsage(): void {
  console.log("artui — k9s-inspired Azure resource client");
  console.log("");
  console.log("Usage:");
  console.log("  artui");
  console.log("  npm run dev");
  console.log("  npm start");
  console.log("");
  console.log("Requires an interactive terminal and Azure CLI authentication.");
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printUsage();
    return;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    printUsage();
    console.error("\nartui requires a TTY.");
    process.exitCode = 1;
    return;
  }

  const app = new ArtuiApp();
  await app.start();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
