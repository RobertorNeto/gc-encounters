import { DB_NAME } from '@/config/constants';
import { LATEST_VERSION, runMigrations } from '@/db/migrations';

let dbPromise: Promise<IDBDatabase> | null = null;
let openConnection: IDBDatabase | null = null;

export function openDb(name = DB_NAME, version = LATEST_VERSION): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(name, version);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const tx = req.transaction;
      if (!tx) throw new Error('upgrade sem transacao');
      runMigrations(db, tx, event.oldVersion, event.newVersion ?? version);
    };
    req.onsuccess = () => {
      openConnection = req.result;
      resolve(req.result);
    };
    req.onerror = () => reject(req.error ?? new Error('falha ao abrir IndexedDB'));
    req.onblocked = () => reject(new Error('IndexedDB bloqueado por outra aba'));
  });
  return dbPromise;
}

/**
 * Fecha a conexao e esquece o cache. Sem o close(), um deleteDatabase posterior
 * fica bloqueado pela conexao aberta (é o que trava os testes).
 */
export function resetDbCache(): void {
  openConnection?.close();
  openConnection = null;
  dbPromise = null;
}

export function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IDBRequest falhou'));
  });
}

export function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('transacao falhou'));
    tx.onabort = () => reject(tx.error ?? new Error('transacao abortada'));
  });
}

export async function withTx<T>(
  stores: string[],
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  const db = await openDb();
  const tx = db.transaction(stores, mode);
  const done = txDone(tx);
  const result = await fn(tx);
  await done;
  return result;
}

/** Percorre um indice por chave exata sem carregar a store inteira. */
export function getAllByIndex<T>(
  tx: IDBTransaction,
  store: string,
  index: string,
  key: IDBValidKey,
): Promise<T[]> {
  return promisify(tx.objectStore(store).index(index).getAll(key) as IDBRequest<T[]>);
}
