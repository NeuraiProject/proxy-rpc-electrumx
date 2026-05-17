const process = require("process");
const getConfig = require("./getConfig");
const wss = require("./wss");

process.on("uncaughtException", (error, origin) => {
  console.log("----- Uncaught exception -----");
  console.log(error);
  console.log("----- Exception origin -----");
  console.log(origin);
});

process.on("unhandledRejection", (reason, promise) => {
  console.log("----- Unhandled Rejection at -----");
  console.log(promise);
  console.log("----- Reason -----");
  console.log(reason);
});

const config = getConfig();

if (!config.wss || config.wss.enabled !== true) {
  console.log(
    "[WSS] disabled in config (wss.enabled !== true). Nothing to start.",
  );
  process.exit(0);
}

try {
  wss.start(config.wss, config);
} catch (e) {
  console.log("[WSS] failed to start:", e && e.message ? e.message : e);
  process.exit(1);
}
