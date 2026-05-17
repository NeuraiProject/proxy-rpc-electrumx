const sessionMod = require("./session");
const subscriptions = require("./subscriptions");
const { makeEvent } = require("./protocol");

// Broadcast an event to every session that has finished the hello handshake.
function broadcast(method, params) {
  const evt = makeEvent(method, params);
  let count = 0;
  for (const s of sessionMod.getAllSessions()) {
    if (!s.helloDone) continue;
    if (sessionMod.sendJson(s, evt)) count++;
  }
  return count;
}

// Send an event to all sessions subscribed to a particular address.
function notifyAddress(address, method, params) {
  const subs = subscriptions.getSubscribers(address);
  if (!subs || subs.size === 0) return 0;
  const evt = makeEvent(method, params);
  let count = 0;
  for (const s of subs) {
    if (!s.helloDone) continue;
    if (sessionMod.sendJson(s, evt)) count++;
  }
  return count;
}

module.exports = { broadcast, notifyAddress };
