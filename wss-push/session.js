let nextId = 1;
const allSessions = new Set();

function createSession(ws, ip) {
  const session = {
    id: nextId++,
    ws,
    ip: ip || null,
    helloDone: false,
    subs: new Set(),
    createdAt: Date.now(),
    lastSeen: Date.now(),
    msgCount: 0,
  };
  allSessions.add(session);
  return session;
}

function destroySession(session) {
  allSessions.delete(session);
}

function getStats() {
  return { sessionCount: allSessions.size };
}

function getAllSessions() {
  return allSessions;
}

function sendJson(session, obj) {
  if (!session || !session.ws) return false;
  if (session.ws.readyState !== 1) return false;
  try {
    session.ws.send(JSON.stringify(obj));
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  createSession,
  destroySession,
  getStats,
  getAllSessions,
  sendJson,
};
