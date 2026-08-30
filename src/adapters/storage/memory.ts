import type { BlobStore } from '../../core/ports.js';

/** Blob store en memoria. Es el primer pago de tener el puerto: unit tests sin Docker. */
export function inMemoryBlobStore(): BlobStore & { size(): number } {
  const store = new Map<string, { bytes: Buffer; mediaType: string }>();
  return {
    async put(key, bytes, mediaType) {
      store.set(key, { bytes: Buffer.from(bytes), mediaType });
    },
    async get(key) {
      const hit = store.get(key);
      if (!hit) throw new Error(`blob no encontrado: ${key}`);
      return hit.bytes;
    },
    async delete(key) {
      store.delete(key);
    },
    async exists(key) {
      return store.has(key);
    },
    async healthy() {
      return true;
    },
    size: () => store.size,
  };
}
