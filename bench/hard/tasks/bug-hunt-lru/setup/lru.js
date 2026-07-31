// lru.js — LRU cache with max size and optional TTL.
//
// API contract:
//   const c = new LRUCache(maxSize, ttlMs = 0, nowFn = Date.now)
//     ttlMs = 0 means entries never expire; nowFn is injectable for testing.
//   c.set(key, value)  insert or update. Updating an existing key must NOT
//                      grow the cache and must make that key most-recently-used,
//                      with a fresh TTL. When an insert pushes the cache past
//                      maxSize, the LEAST-recently-used entry is evicted.
//   c.get(key)         value or undefined. A hit makes the key most-recently-used.
//                      An expired entry is purged and treated as a miss.
//   c.has(key)         true only for present, NON-expired entries.
//   c.delete(key)      removes the entry; returns true if it existed.
//   c.keys()           live keys in LRU order: least-recently-used first.
//   c.size             number of live entries.
class LRUCache {
  constructor(maxSize, ttlMs = 0, nowFn = Date.now) {
    if (!Number.isInteger(maxSize) || maxSize < 1) throw new Error("maxSize must be a positive integer");
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.now = nowFn;
    this.map = new Map();
    this.count = 0;
  }

  _expired(entry) {
    return this.ttlMs > 0 && this.now() > entry.expiresAt;
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (this._expired(entry)) {
      this.map.delete(key);
      this.count--;
      return undefined;
    }
    return entry.value;
  }

  set(key, value) {
    const entry = { value, expiresAt: this.now() + this.ttlMs };
    this.map.set(key, entry);
    this.count++;
    if (this.count > this.maxSize) {
      const keys = [...this.map.keys()];
      const victim = keys[keys.length - 1];
      this.map.delete(victim);
      this.count--;
    }
  }

  has(key) {
    return this.map.has(key);
  }

  delete(key) {
    if (this.map.delete(key)) {
      this.count--;
      return true;
    }
    return false;
  }

  keys() {
    return [...this.map.keys()];
  }

  get size() {
    return this.count;
  }
}

module.exports = LRUCache;
