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
  default:
    console.log(`
Heimdall — The All-Seeing PR Guardian

Usage: heimdall <command>

Commands:
  run          Execute a single poll cycle
  start        Start the daemon (launchd)
  stop         Stop the daemon
  status       Show running state and recent reviews
  logs         Tail the log file
  install      Generate and load launchd plist
  uninstall    Remove launchd plist
    `);
    break;
}
