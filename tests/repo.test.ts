import { describe, expect, it } from 'vitest';
import {
  exportAll,
  getEncounters,
  getGroupStats,
  getPlayerMaps,
  getMonthlyResults,
  getSharedMatches,
  getStats,
  getTopEncounters,
  importAll,
  outcomeOf,
  repairResults,
  saveMatch,
  searchPlayers,
  setNote,
  updateMeta,
  wipe,
} from '@/db/repo';
import { recomputeAllCounters } from '@/db/repo';
import { withTx } from '@/lib/idb';
import { STORES } from '@/db/schema';
import type { Match as MatchType, MatchPlayer, MatchRecord, Player } from '@/types';

const ME = 1000;

function match(id: string, playedAt: number, others: number[], sameTeam: number[] = []): MatchRecord {
  const players: MatchRecord['players'] = [
    { gcId: ME, nick: 'eu', team: 'A', level: 15, wasMe: true },
  ];
  for (const gcId of sameTeam) {
    players.push({ gcId, nick: `mate${gcId}`, team: 'A', level: 10, wasMe: false });
  }
  for (const gcId of others) {
    players.push({ gcId, nick: `foe${gcId}`, team: 'B', level: 12, wasMe: false });
  }
  return { match: { matchId: id, playedAt, map: 'de_mirage', score: '16-14' }, players };
}

describe('saveMatch', () => {
  it('grava partida, jogadores e relação com o meu time', async () => {
    await saveMatch(match('m1', 1_700_000_000_000, [2, 3, 4, 5, 6], [7, 8]), 'live');

    const stats = await getStats();
    expect(stats.matches).toBe(1);
    expect(stats.players).toBe(8);

    const enc = await getEncounters([2, 7, ME]);
    expect(enc.get(2)).toMatchObject({ total: 1, against: 1, together: 0 });
    expect(enc.get(7)).toMatchObject({ total: 1, against: 0, together: 1 });
    expect(enc.get(ME)).toMatchObject({ total: 1, against: 0, together: 0 });
  });

  it('é idempotente: 3x o mesmo registro = mesmo estado', async () => {
    const rec = match('m1', 1_700_000_000_000, [2, 3, 4, 5, 6], [7, 8]);
    await saveMatch(rec, 'live');
    const first = await exportAll();
    await saveMatch(rec, 'live');
    await saveMatch(rec, 'backfill');
    const third = await exportAll();

    expect(third.matches).toEqual(first.matches);
    expect(third.matchPlayers).toEqual(first.matchPlayers);
    expect(third.players.map((p) => [p.gcId, p.totalMatches, p.totalAgainst, p.totalTogether]))
      .toEqual(first.players.map((p) => [p.gcId, p.totalMatches, p.totalAgainst, p.totalTogether]));
  });

  it('não regride uma partida já coletada ao vivo para backfill', async () => {
    const rec = match('m1', 1_700_000_000_000, [2, 3, 4, 5, 6]);
    await saveMatch(rec, 'live');
    await saveMatch(rec, 'backfill');
    const dump = await exportAll();
    expect(dump.matches[0]?.source).toBe('live');
  });

  it('corrige contadores quando a partida é reprocessada com elenco diferente', async () => {
    await saveMatch(match('m1', 1, [2, 3, 4, 5, 6]), 'live');
    // Mesma matchId, jogador 2 saiu e 9 entrou.
    await saveMatch(match('m1', 1, [9, 3, 4, 5, 6]), 'live');

    const enc = await getEncounters([2, 9]);
    expect(enc.get(2)).toBeUndefined(); // sem participação sobrando, jogador some
    expect(enc.get(9)?.total).toBe(1);
    expect((await getStats()).matchPlayers).toBe(6);
  });

  it('acumula reencontros entre partidas e guarda a última', async () => {
    await saveMatch(match('m1', 1_000, [2, 3, 4, 5, 6]), 'live');
    await saveMatch(match('m2', 2_000, [3, 4, 5, 6, 7]), 'live');
    await saveMatch(match('m3', 3_000, [], [2, 3, 4, 5]), 'live');

    const enc = await getEncounters([2, 3]);
    expect(enc.get(2)).toMatchObject({ total: 2, against: 1, together: 1, lastPlayedAt: 3_000 });
    expect(enc.get(3)).toMatchObject({ total: 3, against: 2, together: 1, lastMatchId: 'm3' });
  });

  it('mantém histórico de nick sem perder o mais recente', async () => {
    await saveMatch(match('m1', 1_000, [2, 3, 4, 5, 6]), 'live');
    const renamed = match('m2', 2_000, [3, 4, 5, 6, 7]);
    renamed.players[1]!.nick = 'novoNick';
    await saveMatch(renamed, 'live');

    const dump = await exportAll();
    const p3 = dump.players.find((p) => p.gcId === 3);
    expect(p3?.nick).toBe('novoNick');
    expect(p3?.nickHistory.map((h) => h.nick)).toEqual(['foe3', 'novoNick']);
  });
});

describe('getSharedMatches', () => {
  it('lista partidas em comum da mais recente para a mais antiga', async () => {
    await saveMatch(match('m1', 1_000, [2, 3, 4, 5, 6]), 'live');
    await saveMatch(match('m2', 2_000, [], [2, 3, 4, 5]), 'live');

    const shared = await getSharedMatches(2);
    expect(shared.map((s) => s.matchId)).toEqual(['m2', 'm1']);
    expect(shared[0]).toMatchObject({ relation: 'together', map: 'de_mirage', score: '16-14' });
  });
});

describe('notas, busca e ranking', () => {
  it('salva, lê e limpa anotação', async () => {
    await saveMatch(match('m1', 1_000, [2, 3, 4, 5, 6]), 'live');
    await setNote(2, '  suspeito  ');
    expect((await getEncounters([2])).get(2)?.note).toBe('suspeito');
    await setNote(2, '   ');
    expect((await getEncounters([2])).get(2)?.note).toBeUndefined();
  });

  it('busca por nick e por id', async () => {
    await saveMatch(match('m1', 1_000, [2, 3, 4, 5, 6]), 'live');
    expect((await searchPlayers('foe3')).map((p) => p.gcId)).toEqual([3]);
    expect((await searchPlayers('4')).map((p) => p.gcId)).toContain(4);
  });

  it('ranqueia por total de reencontros e me deixa de fora', async () => {
    await updateMeta({ myGcId: ME });
    await saveMatch(match('m1', 1_000, [2, 3, 4, 5, 6]), 'live');
    await saveMatch(match('m2', 2_000, [2, 7, 8, 9, 10]), 'live');
    const top = await getTopEncounters(3);
    expect(top.map((p) => p.gcId)).not.toContain(ME);
    expect(top[0]).toMatchObject({ gcId: 2, total: 2, against: 2 });
  });
});

describe('export / import / wipe', () => {
  it('round-trip preserva contadores', async () => {
    await saveMatch(match('m1', 1_000, [2, 3, 4, 5, 6], [7, 8]), 'live');
    const dump = await exportAll();
    await wipe();
    expect((await getStats()).matches).toBe(0);

    await importAll(dump);
    const enc = await getEncounters([2, 7]);
    expect(enc.get(2)).toMatchObject({ total: 1, against: 1 });
    expect(enc.get(7)).toMatchObject({ total: 1, together: 1 });
  });

  it('recusa arquivo estranho', async () => {
    await expect(importAll({ format: 'outra-coisa' } as never)).rejects.toThrow();
  });
});

describe('desempenho', () => {
  /** Semeia direto nas stores: 2000 partidas via saveMatch levariam minutos. */
  async function seed(matches: number, pool: number): Promise<void> {
    const players: Player[] = [];
    const rows: MatchPlayer[] = [];
    const list: MatchType[] = [];
    for (let i = 0; i < matches; i += 1) {
      const matchId = `m${i}`;
      const playedAt = 1_600_000_000_000 + i * 60_000;
      list.push({
        matchId,
        playedAt,
        map: 'de_dust2',
        score: '16-10',
        result: 'win',
        source: 'backfill',
        collectedAt: playedAt,
      });
      const ids = [ME, ...Array.from({ length: 9 }, (_, k) => ((i * 9 + k) % pool) + 1)];
      ids.forEach((gcId, idx) => {
        rows.push({
          matchId,
          gcId,
          team: idx < 5 ? 'A' : 'B',
          levelAtMatch: 10,
          wasMe: gcId === ME,
          relation: gcId === ME ? 'me' : idx < 5 ? 'together' : 'against',
          playedAt,
          result: 'win',
        });
      });
    }
    const seen = new Set<number>();
    for (const r of rows) {
      if (seen.has(r.gcId)) continue;
      seen.add(r.gcId);
      players.push({
        gcId: r.gcId,
        nick: `p${r.gcId}`,
        nickHistory: [{ nick: `p${r.gcId}`, seenAt: r.playedAt }],
        lastLevel: 10,
        firstSeen: r.playedAt,
        lastSeen: r.playedAt,
        totalMatches: 0,
        totalAgainst: 0,
        totalTogether: 0,
        totalWins: 0,
        totalLosses: 0,
        totalDraws: 0,
        lastPlayedAt: r.playedAt,
        lastMatchId: null,
      });
    }
    await withTx([STORES.matches, STORES.matchPlayers, STORES.players], 'readwrite', (tx) => {
      for (const m of list) tx.objectStore(STORES.matches).put(m);
      for (const r of rows) tx.objectStore(STORES.matchPlayers).put(r);
      for (const p of players) tx.objectStore(STORES.players).put(p);
    });
    await recomputeAllCounters();
  }

  it('getEncounters responde 10 jogadores em menos de 50 ms com 2000 partidas', async () => {
    await seed(2000, 5000);
    expect((await getStats()).matches).toBe(2000);

    const probe = [11, 22, 33, 44, 55, 66, 77, 88, 99, 111];
    await getEncounters([1]); // aquece a conexao; o teste mede a consulta, nao o open()

    const t0 = performance.now();
    const enc = await getEncounters(probe);
    const elapsed = performance.now() - t0;

    expect(enc.size).toBeGreaterThan(0);
    for (const e of enc.values()) expect(e.total).toBe(e.against + e.together);
    expect(elapsed).toBeLessThan(50);
  }, 300_000);
});

describe('vitória e derrota', () => {
  it('deriva o resultado do placar e do meu time', () => {
    expect(outcomeOf('13-8', 'A')).toBe('win');
    expect(outcomeOf('13-8', 'B')).toBe('loss');
    expect(outcomeOf('8-13', 'A')).toBe('loss');
    expect(outcomeOf('15-15', 'A')).toBe('draw');
  });

  it('não chuta quando falta placar ou time', () => {
    expect(outcomeOf(null, 'A')).toBeNull();
    expect(outcomeOf('13-8', null)).toBeNull();
    expect(outcomeOf('sem placar', 'A')).toBeNull();
  });

  it('conta V/D por jogador reencontrado', async () => {
    await updateMeta({ myGcId: ME });
    // Eu sempre no time A: 16-14 vence, placar invertido perde.
    await saveMatch(match('m1', 1_000, [2, 3, 4, 5, 6], [7]), 'live');
    const lost = match('m2', 2_000, [2, 3, 4, 5, 6], [7]);
    lost.match.score = '14-16';
    await saveMatch(lost, 'live');

    const enc = await getEncounters([2, 7]);
    expect(enc.get(2)).toMatchObject({ total: 2, wins: 1, losses: 1, draws: 0, decided: 2 });
    expect(enc.get(7)).toMatchObject({ wins: 1, losses: 1 });
  });

  it('partida sem placar não vira derrota: fica fora do percentual', async () => {
    await updateMeta({ myGcId: ME });
    const semPlacar = match('m1', 1_000, [2, 3, 4, 5, 6]);
    semPlacar.match.score = null;
    await saveMatch(semPlacar, 'live');

    const enc = await getEncounters([2]);
    expect(enc.get(2)).toMatchObject({ total: 1, wins: 0, losses: 0, decided: 0 });
  });

  it('getSharedMatches devolve o resultado de cada partida', async () => {
    await saveMatch(match('m1', 1_000, [2, 3, 4, 5, 6]), 'live');
    const shared = await getSharedMatches(2);
    expect(shared[0]?.result).toBe('win');
  });

  it('repairResults preenche registros gravados sem resultado', async () => {
    await saveMatch(match('m1', 1_000, [2, 3, 4, 5, 6]), 'live');
    // Simula o banco antigo: apaga o resultado da partida e das linhas.
    await withTx([STORES.matches, STORES.matchPlayers, STORES.players], 'readwrite', async (tx) => {
      const matches = tx.objectStore(STORES.matches);
      const m = (await new Promise<MatchType>((res) => {
        const q = matches.get('m1');
        q.onsuccess = () => res(q.result as MatchType);
      })) as MatchType;
      matches.put({ ...m, result: null });
      const rows = tx.objectStore(STORES.matchPlayers);
      const all = (await new Promise<MatchPlayer[]>((res) => {
        const q = rows.getAll();
        q.onsuccess = () => res(q.result as MatchPlayer[]);
      })) as MatchPlayer[];
      for (const r of all) rows.put({ ...r, result: null });
      const players = tx.objectStore(STORES.players);
      const ps = (await new Promise<Player[]>((res) => {
        const q = players.getAll();
        q.onsuccess = () => res(q.result as Player[]);
      })) as Player[];
      for (const p of ps) players.put({ ...p, totalWins: 0, totalLosses: 0, totalDraws: 0 });
    });

    expect((await getEncounters([2])).get(2)?.wins).toBe(0);
    const repaired = await repairResults();
    expect(repaired.matches).toBe(1);
    expect((await getEncounters([2])).get(2)).toMatchObject({ wins: 1, decided: 1 });
  });

  it('repairResults é idempotente', async () => {
    await saveMatch(match('m1', 1_000, [2, 3, 4, 5, 6]), 'live');
    await repairResults();
    const second = await repairResults();
    expect(second).toEqual({ matches: 0, rows: 0 });
  });
});

describe('K/D e resumo mensal', () => {
  it('acumula kills/deaths so das linhas que trouxeram o dado', async () => {
    await wipe();
    const withKd = match('k1', Date.UTC(2026, 4, 10), [2]);
    withKd.players[0] = { ...withKd.players[0]!, kills: 20, deaths: 10 };
    withKd.players[1] = { ...withKd.players[1]!, kills: 10, deaths: 20 };
    await saveMatch(withKd, 'backfill');
    // Segunda partida sem K/D: nao entra na razao, mas conta como partida.
    await saveMatch(match('k2', Date.UTC(2026, 4, 12), [2]), 'backfill');

    const enc = await getEncounters([2, ME]);
    expect(enc.get(2)).toMatchObject({ total: 2, kills: 10, deaths: 20, kdRows: 1 });
    expect(enc.get(ME)).toMatchObject({ total: 2, kills: 20, deaths: 10, kdRows: 1 });
  });

  it('getMonthlyResults agrupa por mes local com meu V/D/E', async () => {
    await wipe();
    const may = new Date(2026, 4, 10).getTime();
    const june = new Date(2026, 5, 3).getTime();
    await saveMatch(match('a', may, [2]), 'backfill'); // 16-14, eu no A => vitoria
    const loss = match('b', may + 1000, [2]);
    loss.match.score = '10-16';
    await saveMatch(loss, 'backfill');
    await saveMatch(match('c', june, [2]), 'backfill');

    const monthly = await getMonthlyResults();
    expect(monthly.get('2026-05')).toEqual({ total: 2, wins: 1, losses: 1, draws: 0 });
    expect(monthly.get('2026-06')).toEqual({ total: 1, wins: 1, losses: 0, draws: 0 });
  });
});

describe('aproveitamento separado por relação', () => {
  it('conta MEU resultado em baldes junto/contra', async () => {
    await wipe();
    // Jogador 2 contra (eu venço 16-14), jogador 7 junto (mesma vitoria).
    await saveMatch(match('s1', Date.UTC(2026, 6, 1), [2], [7]), 'backfill');
    // Agora 2 junto e 7 contra, e eu perco.
    const loss = match('s2', Date.UTC(2026, 6, 2), [7], [2]);
    loss.match.score = '9-16';
    await saveMatch(loss, 'backfill');

    const enc = await getEncounters([2, 7]);
    expect(enc.get(2)).toMatchObject({
      together: 1, against: 1,
      togetherWins: 0, togetherLosses: 1, againstWins: 1, againstLosses: 0,
    });
    expect(enc.get(7)).toMatchObject({
      together: 1, against: 1,
      togetherWins: 1, togetherLosses: 0, againstWins: 0, againstLosses: 1,
    });
  });
});

describe('mapas por jogador', () => {
  it('separa juntos e contra, com o resultado certo em cada recorte', async () => {
    await updateMeta({ myGcId: ME });
    const contra = match('m1', 1_000, [2, 3, 4, 5, 6]);
    contra.players[0]!.kills = 25;
    contra.players[0]!.deaths = 15;
    contra.players[1]!.kills = 12;
    contra.players[1]!.deaths = 20;
    await saveMatch(contra, 'live');
    await saveMatch(match('m2', 2_000, [2, 3, 4, 5, 6]), 'live');
    const inferno = match('m3', 3_000, [], [2]);
    inferno.match.map = 'de_inferno';
    inferno.players[1]!.kills = 20;
    inferno.players[1]!.deaths = 10;
    await saveMatch(inferno, 'live');

    const maps = await getPlayerMaps(2);
    // Historico do jogador: perdeu as duas contra mim (time B, 16-14 para A).
    expect(maps.all[0]).toMatchObject({ map: 'de_mirage', played: 2, wins: 0, losses: 2 });
    expect(maps.together).toEqual([
      { map: 'de_inferno', played: 1, wins: 1, losses: 0, draws: 0, kills: 20, deaths: 10, kdRows: 1 },
    ]);
    // Embate: V/D sao MEUS; kills/deaths dele, my* meus.
    expect(maps.against).toEqual([
      {
        map: 'de_mirage', played: 2, wins: 2, losses: 0, draws: 0,
        kills: 12, deaths: 20, kdRows: 1, myKills: 25, myDeaths: 15, myKdRows: 1,
      },
    ]);
  });

  it('para mim: tudo em all, recortes vazios, sem mapa por ultimo', async () => {
    await updateMeta({ myGcId: ME });
    const semMapa = match('m1', 1_000, [2, 3, 4, 5, 6]);
    semMapa.match.map = null;
    await saveMatch(semMapa, 'live');
    await saveMatch(match('m2', 2_000, [2, 3, 4, 5, 6]), 'live');
    const mine = await getPlayerMaps(ME);
    expect(mine.all.map((m) => m.map)).toEqual(['de_mirage', null]);
    expect(mine.all[0]).toMatchObject({ played: 1, wins: 1 });
    expect(mine.together).toEqual([]);
    expect(mine.against).toEqual([]);
  });
});

describe('agregador', () => {
  it('so conta partidas com todos os escolhidos no mesmo time', async () => {
    await saveMatch(match('m1', 1_000, [4, 5, 6], [2, 3]), 'live'); // 2 e 3 juntos
    await saveMatch(match('m2', 2_000, [3, 5, 6], [2]), 'live'); // 2 e 3 em lados opostos
    await saveMatch(match('m3', 3_000, [4, 5, 6], [2]), 'live'); // 3 ausente

    const team = await getGroupStats([2, 3], 'team');
    expect(team.matches.map((m) => m.matchId)).toEqual(['m1']);
    expect(team).toMatchObject({ sameTeam: 1, wins: 1, losses: 0 });

    const any = await getGroupStats([2, 3], 'match');
    expect(any.matches.map((m) => m.matchId)).toEqual(['m2', 'm1']);
    expect(any.sameTeam).toBe(1);
    // Em m2 cada um tem o proprio resultado; o grupo nao tem.
    expect(any.matches[0]).toMatchObject({ sameTeam: false, result: null });
    expect(any.players.find((p) => p.gcId === 3)).toMatchObject({ played: 2, wins: 1, losses: 1 });
  });

  it('soma K/D por jogador e mapas do grupo', async () => {
    const rec = match('m1', 1_000, [4, 5, 6], [2, 3]);
    rec.players[1]!.kills = 10;
    rec.players[1]!.deaths = 5;
    await saveMatch(rec, 'live');
    await saveMatch(match('m2', 2_000, [4, 5, 6], [2, 3]), 'live');

    const g = await getGroupStats([ME, 2]);
    expect(g.players.map((p) => p.gcId)).toEqual([ME, 2]);
    expect(g.players[1]).toMatchObject({ played: 2, kills: 10, deaths: 5, kdRows: 1 });
    expect(g.maps).toEqual([
      { map: 'de_mirage', played: 2, wins: 2, losses: 0, draws: 0, kills: 10, deaths: 5, kdRows: 1 },
    ]);
  });

  it('ignora duplicados, corta em eu + 4 e responde vazio sem jogador', async () => {
    expect((await getGroupStats([])).matches).toEqual([]);
    await saveMatch(match('m1', 1_000, [6], [2, 3, 4, 5]), 'live');
    const g = await getGroupStats([ME, 2, 2, 3, 4, 5, 6]);
    expect(g.players.map((p) => p.gcId)).toEqual([ME, 2, 3, 4, 5]);
    expect(g.matches).toHaveLength(1);
  });
});
