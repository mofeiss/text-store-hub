import { handleRequest } from './handler.js';
import { createDenoKVStore } from './deno-store.js';

const adminPassword = Deno.env.get("ADMIN_PASSWORD");

if (!adminPassword) {
  console.error("Missing ADMIN_PASSWORD environment variable.");
  Deno.exit(1);
}

// 尝试打开 Deno KV
// 在 Deno Deploy 环境下，它会自动连接到分配到的 KV
// 本机开发环境下，它会在当前目录创建一个本地 SQLite 存储文件，并使用它
const kv = await Deno.openKv();
const store = createDenoKVStore(kv);

Deno.serve(async (request) => {
  try {
    return await handleRequest(request, {
      adminPassword,
      store,
    });
  } catch (error) {
    console.error(error);
    return new Response(error?.message || 'Internal Server Error', { status: 500 });
  }
});
