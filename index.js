const process = require("process");
const getConfig = require("./getConfig");
const wssPush = require("./wss-push");

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

if (!config.wss_push || config.wss_push.enabled !== true) {
  console.log(
    "[WSS-PUSH] disabled in config (wss_push.enabled !== true). Nothing to start.",
  );
  process.exit(0);
}

try {
  wssPush.start(config.wss_push, config);
} catch (e) {
  console.log("[WSS-PUSH] failed to start:", e && e.message ? e.message : e);
  process.exit(1);
}
