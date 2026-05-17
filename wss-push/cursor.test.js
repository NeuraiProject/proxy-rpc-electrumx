const cursor = require("./cursor");

test("encode produces 'height:tx_index:asset'", () => {
  expect(cursor.encode(123, 5, "XNA")).toBe("123:5:XNA");
  expect(cursor.encode(0, 0, "TRON!")).toBe("0:0:TRON!");
});

test("encode returns null for invalid inputs", () => {
  expect(cursor.encode(-1, 0, "XNA")).toBe(null);
  expect(cursor.encode(0, -1, "XNA")).toBe(null);
  expect(cursor.encode("a", 0, "XNA")).toBe(null);
  expect(cursor.encode(0, NaN, "XNA")).toBe(null);
  expect(cursor.encode(0, Infinity, "XNA")).toBe(null);
  expect(cursor.encode(0, 0, "")).toBe(null);
  expect(cursor.encode(0, 0, "has:colon")).toBe(null);
  expect(cursor.encode(0, 0, 123)).toBe(null);
});

test("encode floors floats", () => {
  expect(cursor.encode(123.7, 5.2, "XNA")).toBe("123:5:XNA");
});

test("decode null/empty yields the start position", () => {
  expect(cursor.decode(null)).toEqual({ height: 0, tx_index: 0, asset: "" });
  expect(cursor.decode(undefined)).toEqual({ height: 0, tx_index: 0, asset: "" });
  expect(cursor.decode("")).toEqual({ height: 0, tx_index: 0, asset: "" });
});

test("decode parses valid cursors", () => {
  expect(cursor.decode("75880:3:XNA")).toEqual({ height: 75880, tx_index: 3, asset: "XNA" });
  expect(cursor.decode("0:0:TRON!")).toEqual({ height: 0, tx_index: 0, asset: "TRON!" });
});

test("decode accepts legacy 'height:tx_index' as asset=''", () => {
  // Pre-asset-history clients may have persisted these. asset:"" sorts before
  // any real asset so the next page starts at the beginning of that slot.
  expect(cursor.decode("75880:3")).toEqual({ height: 75880, tx_index: 3, asset: "" });
  expect(cursor.decode("0:0")).toEqual({ height: 0, tx_index: 0, asset: "" });
});

test("decode rejects malformed cursors", () => {
  expect(cursor.decode("foo")).toBe(null);
  expect(cursor.decode("123")).toBe(null);
  expect(cursor.decode("-1:0:XNA")).toBe(null);
  expect(cursor.decode("1:2:")).toBe(null);
  expect(cursor.decode("1:2:a:b")).toBe(null);
  expect(cursor.decode(123)).toBe(null);
});

test("encode/decode roundtrip", () => {
  const original = { height: 75880, tx_index: 3, asset: "XNA" };
  const encoded = cursor.encode(original.height, original.tx_index, original.asset);
  const decoded = cursor.decode(encoded);
  expect(decoded).toEqual(original);
});

test("encodeUtxo produces 'height:vout:txid'", () => {
  expect(cursor.encodeUtxo(75900, 0, "471e4da0ee1ded98ec8e6c20840763dcae7fd8151fab95f9d05c33c9c69bd5dd"))
    .toBe("75900:0:471e4da0ee1ded98ec8e6c20840763dcae7fd8151fab95f9d05c33c9c69bd5dd");
});

test("encodeUtxo rejects invalid inputs", () => {
  expect(cursor.encodeUtxo(-1, 0, "abc")).toBe(null);
  expect(cursor.encodeUtxo(0, -1, "abc")).toBe(null);
  expect(cursor.encodeUtxo(0, 0, "")).toBe(null);
  expect(cursor.encodeUtxo(0, 0, "not-hex!")).toBe(null);
  expect(cursor.encodeUtxo(NaN, 0, "abc")).toBe(null);
});

test("decodeUtxo parses valid cursors", () => {
  expect(cursor.decodeUtxo("75900:3:471e4da0"))
    .toEqual({ height: 75900, vout: 3, txid: "471e4da0" });
});

test("decodeUtxo rejects malformed cursors", () => {
  expect(cursor.decodeUtxo(null)).toBe(null);
  expect(cursor.decodeUtxo("")).toBe(null);
  expect(cursor.decodeUtxo("foo")).toBe(null);
  expect(cursor.decodeUtxo("75900:3")).toBe(null);
  expect(cursor.decodeUtxo("75900:3:not-hex!")).toBe(null);
  expect(cursor.decodeUtxo(12345)).toBe(null);
});

test("encodeUtxo/decodeUtxo roundtrip", () => {
  const original = {
    height: 75900,
    vout: 0,
    txid: "471e4da0ee1ded98ec8e6c20840763dcae7fd8151fab95f9d05c33c9c69bd5dd",
  };
  const encoded = cursor.encodeUtxo(original.height, original.vout, original.txid);
  const decoded = cursor.decodeUtxo(encoded);
  expect(decoded).toEqual(original);
});
