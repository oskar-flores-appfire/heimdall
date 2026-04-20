#!/usr/bin/env bun

const command = process.argv[2];

switch (command) {
  case "run": {
    const { run } = await import("./cli/run");
    await run();
    break;
  }
  case "start": {
    const { start } = await import("./cli/start");
    await start();
    break;
  }
  case "stop": {
    const { stop } = await import("./cli/stop");
    await stop();
    break;
  }
  case "status": {
    const { status } = await import("./cli/status");
    await status();
    break;
  }
  case "logs": {
    const { logs } = await import("./cli/logs");
    await logs();
    break;
  }
  case "install": {
    const { install } = await import("./cli/install");
    await install();
    break;
  }
  case "uninstall": {
    const { uninstall } = await import("./cli/uninstall");
    await uninstall();
    break;
  }
  case "reinstall": {
    const { reinstall } = await import("./cli/reinstall");
    await reinstall();
    break;
  }
  case "triage": {
    const { triage } = await import("./cli/triage");
    await triage();
    break;
  }
  case "approve": {
    const { approve } = await import("./cli/approve");
    await approve();
    break;
  }
  case "worker": {
    const { workerCmd } = await import("./cli/worker-cmd");
    await workerCmd();
    break;
  }
  case "queue": {
    const { queueCmd } = await import("./cli/queue-cmd");
    await queueCmd();
    break;
  }
  case "clean": {
    const { clean } = await import("./cli/clean");
    await clean();
    break;
  }
  case "open": {
    const { open } = await import("./cli/open");
    await open();
    break;
  }
  case "help":
  case "--help":
  case "-h":
  default:
    console.log(`
Heimdall — The All-Seeing PR Guardian

Usage: heimdall <command>

Commands:
  run              Start persistent mode (server + polling loop)
  run --once       Execute a single poll cycle and exit
  start            Start the daemon (launchd)
  stop             Stop the daemon
  status           Show running state and recent reviews
  logs             Tail the log file
  install          Generate and load launchd plist
  reinstall        Stop and reload the daemon
  uninstall        Remove launchd plist
  open <number>    Open a review in browser (detects repo from cwd)

Jira Autonomous Implementation:
  triage <KEY>     View triage report and approve
  approve <KEY>    Queue issue for implementation
  worker           Start worker (picks up queue items)
  queue            List queue items with status
  clean            Remove completed/old worktrees
    `);
    break;
}
