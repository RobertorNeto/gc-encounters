import 'fake-indexeddb/auto';
import { afterEach, beforeEach } from 'vitest';
import { DB_NAME } from '@/config/constants';
import { resetDbCache } from '@/lib/idb';

/** Cada teste começa com banco vazio: o cache de conexão do idb.ts é global. */
async function dropDb(): Promise<void> {
  resetDbCache();
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

beforeEach(dropDb);
afterEach(dropDb);
