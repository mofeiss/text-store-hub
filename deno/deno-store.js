export function createDenoKVStore(kv) {
  return {
    async get(key) {
      const result = await kv.get(["store", key]);
      if (!result.value) {
        return null;
      }
      return String(result.value);
    },

    async put(key, value) {
      await kv.set(["store", key], String(value ?? ''));
    },

    async delete(key) {
      await kv.delete(["store", key]);
    },
  };
}
