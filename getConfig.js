function getConfig() {
  try {
    const config = require("./config.json");
    return config;
  } catch (e) {
    console.log("Could not find config.json");
    console.log("Please create a config.json file");

    const template = `
    {
      "wss_push": {
        "enabled": true,
        "host": "0.0.0.0",
        "port": 19020,
        "path": "/push",
        "tls_enabled": false,
        "auth_transport": "sec-websocket-protocol",
        "auth_token": "CHANGE-ME-BEFORE-EXPOSING-PUBLICLY",
        "max_sessions": 5000,
        "max_subscriptions_per_session": 200,
        "max_new_connections_per_second": 50,
        "send_initial_state": true,
        "zmq_enabled": true,
        "zmq_endpoint": "tcp://localhost:28332"
      },
      "nodes": [
        {
          "name": "Local Neurai Node with DePIN",
          "username": "dauser",
          "password": "dapassword",
          "neurai_url": "http://localhost:19001",
          "depin_enabled": true,
          "depin_url": "http://localhost:19002"
        }
      ]
    }
      `;

    console.log("Example content of config.json");
    console.info(template);

    process.exit(1);
  }
}

module.exports = getConfig;
