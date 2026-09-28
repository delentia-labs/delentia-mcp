/**
 * A minimal, real (not mocked-away) fake Cloudflare Durable Object
 * namespace for testing worker code outside Wrangler. Each unique name
 * passed to idFromName() gets its own persistent in-memory storage Map and
 * its own DO class instance, exactly matching real DO semantics: the same
 * name always resolves to the same instance (state persists across calls
 * within a test), while different names resolve to fully isolated
 * instances. This is not a mock of the DO class under test — the actual
 * DOClass constructor and its actual fetch() handler run for real; only
 * the underlying `storage.get/put` persistence layer (normally Cloudflare's
 * own infrastructure) is replaced with a plain Map, since that's the only
 * part Wrangler itself would otherwise have to provide.
 */
export function createFakeDurableObjectNamespace(DOClass) {
  const instances = new Map();

  function makeState() {
    const store = new Map();
    return {
      storage: {
        async get(key) {
          return store.has(key) ? store.get(key) : undefined;
        },
        async put(key, value) {
          store.set(key, value);
        },
      },
      // Real DO classes may call this; our fakes don't need real concurrency
      // blocking since these tests are single-threaded, but some DO classes
      // (see DeltaSessionDO) call it in their constructor.
      blockConcurrencyWhile: async (fn) => fn(),
    };
  }

  return {
    idFromName(name) {
      return name;
    },
    get(id) {
      if (!instances.has(id)) {
        instances.set(id, new DOClass(makeState()));
      }
      const instance = instances.get(id);
      // Real Cloudflare `namespace.get(id)` returns a "stub" whose
      // `.fetch(urlOrRequest, init)` signature mirrors global fetch() and
      // internally builds a Request before invoking the DO instance's own
      // `fetch(request)`. Mirror that here so worker code written against
      // the real stub.fetch(url, init) calling convention works unchanged.
      return {
        fetch(urlOrRequest, init) {
          const request = urlOrRequest instanceof Request ? urlOrRequest : new Request(urlOrRequest, init);
          return instance.fetch(request);
        },
      };
    },
  };
}
