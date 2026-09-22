import { describe, expect, it } from 'vitest';
import { DB_NAME } from '@/config/constants';
import { LATEST_VERSION, MIGRATIONS, runMigrations } from '@/db/migrations';
import { INDEXES, STORES } from '@/db/schema';
import { openDb, promisify, resetDbCache } from '@/lib/idb';
import { getStats, saveMatch } from '@/db/repo';
import type { MatchRecord } from '@/types';

const rec: MatchRecord = {
  match: { matchId: 'm1', playedAt: 1_000, map: 'de_nuke', score: '16-9' },
  players: [
    { gcId: 1, nick: 'eu', team: 'A', level: 15, wasMe: true },
    { gcId: 2, nick: 'a', team: 'A', level: 10, wasMe: false },
    { gcId: 3, nick: 'b', team: 'B', level: 11, wasMe: false },
    { gcId: 4, nick: 'c', team: 'B', level: 12, wasMe: false },
  ],
};

function openRaw(version: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, version);
    req.onupgradeneeded = (ev) => {
      const tx = req.transaction;
      if (!tx) throw new Error('sem transacao');
      runMigrations(req.result, tx, ev.oldVersion, ev.newVersion ?? version);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

describe('migrations', () => {
  it('cria stores e índices na versão atual', async () => {
    const db = await openDb();
    expect([...db.objectStoreNames].sort()).toEqual(
      [STORES.matchPlayers, STORES.matches, STORES.meta, STORES.players].sort(),
    );
    const tx = db.transaction([STORES.matchPlayers, STORES.players, STORES.matches], 'readonly');
    expect([...tx.objectStore(STORES.matchPlayers).indexNames].sort()).toEqual(
      [INDEXES.matchPlayers.gcId, INDEXES.matchPlayers.matchId].sort(),
    );
    expect([...tx.objectStore(STORES.players).indexNames]).toContain(INDEXES.players.lastSeen);
    expect([...tx.objectStore(STORES.matches).indexNames]).toContain(INDEXES.matches.playedAt);
    expect(tx.objectStore(STORES.matchPlayers).keyPath).toEqual(['matchId', 'gcId']);
  });

  it('LATEST_VERSION acompanha a lista de migrações', () => {
    expect(LATEST_VERSION).toBe(MIGRATIONS.length);
  });

  it('sobe de v0 a LATEST em um passo só e preserva dados ao reabrir', async () => {
    const db = await openRaw(LATEST_VERSION);
    db.close();
    resetDbCache();

    await saveMatch(rec, 'live');
    resetDbCache();

    const stats = await getStats();
    expect(stats.matches).toBe(1);
    expect(stats.matchPlayers).toBe(4);
  });

  it('migração já publicada não é reescrita em cima de dados existentes', async () => {
    await saveMatch(rec, 'live');
    resetDbCache();
    const db = await openDb();
    const tx = db.transaction([STORES.matches], 'readonly');
    const stored = await promisify(tx.objectStore(STORES.matches).get('m1'));
    expect(stored).toBeTruthy();
  });
});
