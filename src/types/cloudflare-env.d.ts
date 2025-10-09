// Ambient type augmentation for Cloudflare worker bindings
declare namespace Cloudflare {
  interface Env {
    GEMINI_API_KEY: string;
  }
}

// Cloudflare Workers provides an edge cache at caches.default but the type is
// not included in standard lib DOM types. Augment it here for type safety.
declare const caches: CacheStorage & { default: Cache };

// Merge with the DOM lib's CacheStorage to declare the default cache binding
interface CacheStorage {
  readonly default: Cache;
}
