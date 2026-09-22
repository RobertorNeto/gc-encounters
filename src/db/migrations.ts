import { INDEXES, STORES } from './schema';

type Migration = (db: IDBDatabase, tx: IDBTransaction) => void;

/**
 * Indice do array = versao de destino. migrations[0] leva de v0 para v1.
 * Nunca editar uma migracao ja publicada: adicionar outra no fim.
 */
export const MIGRATIONS: Migration[] = [
  // v1 — schema inicial
  (db) => {
    const players = db.createObjectStore(STORES.players, { keyPath: 'gcId' });
    players.createIndex(INDEXES.players.lastSeen, 'lastSeen');
    players.createIndex(INDEXES.players.totalMatches, 'totalMatches');

    const matches = db.createObjectStore(STORES.matches, { keyPath: 'matchId' });
    matches.createIndex(INDEXES.matches.playedAt, 'playedAt');

    const matchPlayers = db.createObjectStore(STORES.matchPlayers, {
      keyPath: ['matchId', 'gcId'],
    });
    matchPlayers.createIndex(INDEXES.matchPlayers.gcId, 'gcId');
    matchPlayers.createIndex(INDEXES.matchPlayers.matchId, 'matchId');

    db.createObjectStore(STORES.meta, { keyPath: 'key' });
  },
];

export const LATEST_VERSION = MIGRATIONS.length;

export function runMigrations(db: IDBDatabase, tx: IDBTransaction, from: number, to: number): void {
  for (let v = from; v < to; v += 1) {
    MIGRATIONS[v]?.(db, tx);
  }
}
