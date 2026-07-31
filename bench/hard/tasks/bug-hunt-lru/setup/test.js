// test.js — DO NOT MODIFY. Run with: node test.js
const LRUCache = require("./lru.js");

let t = 0;
const clock = () => t;

let failures = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log("ok   " + name);
  else {
    console.log("FAIL " + name + " — expected " + e + ", got " + a);
    failures++;
  }
}

// 1. basics
{
  const c = new LRUCache(3);
  c.set("a", 1);
  c.set("b", 2);
  eq("basic get", c.get("a"), 1);
  eq("basic size", c.size, 2);
  eq("missing key", c.get("zz"), undefined);
}

// 2. eviction removes the LEAST-recently-used entry
{
  const c = new LRUCache(3);
  c.set("a", 1);
  c.set("b", 2);
  c.set("c", 3);
  c.set("d", 4); // evicts a
  eq("evicts least-recent", c.get("a"), undefined);
  eq("keeps b", c.get("b"), 2);
  eq("keeps d", c.get("d"), 4);
  eq("size stays at max", c.size, 3);
}

// 3. get() refreshes recency
{
  const c = new LRUCache(3);
  c.set("a", 1);
  c.set("b", 2);
  c.set("c", 3);
  c.get("a"); // a becomes most-recent
  c.set("d", 4); // evicts b, NOT a
  eq("get refreshed a", c.get("a"), 1);
  eq("b was evicted", c.get("b"), undefined);
}

// 4. set() on an existing key updates in place and refreshes recency
{
  const c = new LRUCache(3);
  c.set("a", 1);
  c.set("b", 2);
  c.set("c", 3);
  c.set("a", 99); // update, a most-recent, size must stay 3
  eq("update value", c.get("a"), 99);
  eq("update keeps size", c.size, 3);
  c.set("d", 4); // evicts b
  eq("update refreshed a", c.get("a"), 99);
  eq("b evicted after update", c.get("b"), undefined);
}

// 5. keys() in LRU order, least-recently-used first
{
  const c = new LRUCache(3);
  c.set("a", 1);
  c.set("b", 2);
  c.set("c", 3);
  c.get("a");
  eq("keys order", c.keys(), ["b", "c", "a"]);
}

// 6. TTL with an injected clock
{
  const c = new LRUCache(10, 100, clock);
  t = 0;
  c.set("a", 1);
  t = 50;
  eq("not expired at 50", c.get("a"), 1);
  t = 101;
  eq("has() false when expired", c.has("a"), false);
  eq("expired at 101", c.get("a"), undefined);
  eq("size drops after expiry", c.size, 0);
}

// 7. delete
{
  const c = new LRUCache(2);
  c.set("a", 1);
  eq("delete true", c.delete("a"), true);
  eq("delete false", c.delete("a"), false);
  eq("size after delete", c.size, 0);
}

if (failures === 0) {
  console.log("ALL TESTS PASSED");
} else {
  console.log(failures + " FAILURES");
  process.exit(1);
}
