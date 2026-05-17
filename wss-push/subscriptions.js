// address -> Set<session>
const addressSubs = new Map();

function subscribe(address, session) {
  let set = addressSubs.get(address);
  if (!set) {
    set = new Set();
    addressSubs.set(address, set);
  }
  set.add(session);
  session.subs.add(address);
}

function unsubscribe(address, session) {
  const set = addressSubs.get(address);
  if (set) {
    set.delete(session);
    if (set.size === 0) addressSubs.delete(address);
  }
  session.subs.delete(address);
}

function unsubscribeAll(session) {
  for (const address of session.subs) {
    const set = addressSubs.get(address);
    if (set) {
      set.delete(session);
      if (set.size === 0) addressSubs.delete(address);
    }
  }
  session.subs.clear();
}

function getSubscribers(address) {
  return addressSubs.get(address) || null;
}

function getAllSubscribedAddresses() {
  return Array.from(addressSubs.keys());
}

function getStats() {
  let totalSubs = 0;
  for (const set of addressSubs.values()) totalSubs += set.size;
  return {
    distinctAddresses: addressSubs.size,
    totalSubscriptions: totalSubs,
  };
}

module.exports = {
  subscribe,
  unsubscribe,
  unsubscribeAll,
  getSubscribers,
  getAllSubscribedAddresses,
  getStats,
};
