const crypto = require("crypto");
const { statusString, statusHash } = require("./status");

test("empty state produces stable string", () => {
  const s = statusString({});
  expect(s).toBe("balance.confirmed:0|balance.unconfirmed:0|mempool:|utxos:");
});

test("statusString does not include best block hash or height", () => {
  const s = statusString({
    balance: { confirmed: 100, unconfirmed: 0 },
    mempoolTxids: [],
    utxos: [],
  });
  expect(s).not.toMatch(/best/i);
  expect(s).not.toMatch(/height/i);
});

test("mempool txids are sorted lexicographically", () => {
  const a = statusString({ mempoolTxids: ["bbb", "aaa", "ccc"] });
  const b = statusString({ mempoolTxids: ["aaa", "bbb", "ccc"] });
  expect(a).toBe(b);
});

test("utxos sorted by txid, vout, asset", () => {
  const u1 = [
    { txid: "bbb", vout: 1, value: 1, asset: "" },
    { txid: "aaa", vout: 0, value: 2, asset: "" },
    { txid: "aaa", vout: 1, value: 3, asset: "A" },
    { txid: "aaa", vout: 1, value: 3, asset: "B" },
  ];
  const u2 = [
    { txid: "aaa", vout: 1, value: 3, asset: "B" },
    { txid: "aaa", vout: 1, value: 3, asset: "A" },
    { txid: "aaa", vout: 0, value: 2, asset: "" },
    { txid: "bbb", vout: 1, value: 1, asset: "" },
  ];
  expect(statusString({ utxos: u1 })).toBe(statusString({ utxos: u2 }));
});

test("native asset uses empty string", () => {
  const s = statusString({
    utxos: [{ txid: "aa", vout: 0, value: 100, asset: "" }],
  });
  expect(s).toMatch(/utxos:aa:0:100:$/);
});

test("statusHash returns sha256 hex of statusString", () => {
  const state = {
    balance: { confirmed: 1, unconfirmed: 2 },
    mempoolTxids: ["aa"],
    utxos: [{ txid: "bb", vout: 0, value: 5, asset: "" }],
  };
  const expected = crypto
    .createHash("sha256")
    .update(statusString(state))
    .digest("hex");
  expect(statusHash(state)).toBe(expected);
});

test("statusHash is stable across equivalent inputs", () => {
  const a = statusHash({
    balance: { confirmed: 10, unconfirmed: 5 },
    mempoolTxids: ["x", "y"],
    utxos: [
      { txid: "t1", vout: 0, value: 1, asset: "" },
      { txid: "t2", vout: 1, value: 2, asset: "A" },
    ],
  });
  const b = statusHash({
    balance: { unconfirmed: 5, confirmed: 10 },
    mempoolTxids: ["y", "x"],
    utxos: [
      { txid: "t2", vout: 1, value: 2, asset: "A" },
      { txid: "t1", vout: 0, value: 1, asset: "" },
    ],
  });
  expect(a).toBe(b);
});
