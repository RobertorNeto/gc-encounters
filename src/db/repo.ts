import { DEFAULT_THROTTLE_MS, MIN_THROTTLE_MS } from '@/config/constants';
import { getAllByIndex, promisify, withTx } from '@/lib/idb';
import { LATEST_VERSION } from './migrations';
import { INDEXES, META_KEY, STORES } from './schema';
import type {
  Encounter,
  Match,
  MatchPlayer,
  MatchRecord,
  MatchSource,
  Meta,
  Outcome,
  ParseFailure,
  Player,
  PlayerId,
  Relation,
  Team,
} from '@/types';

const ALL_STORES = [STORES.players, STORES.matches, STORES.matchPlayers, STORES.meta];

export function defaultMeta(): Meta {
  return {
    key: META_KEY,
    myGcId: null,
    schemaVersion: LATEST_VERSION,
    throttleMs: DEFAULT_THROTTLE_MS,
    lastFailure: null,
    resultsRepairedAt: null,
    backfill: {
      status: 'idle',
      cursor: null,
      pagesDone: 0,
      matchesDone: 0,
      consecutiveFailures: 0,
      startedAt: null,
      updatedAt: null,
      queue: [],
      periods: [],
      oldestPeriod: null,
      donePeriods: [],
      emptyMonths: 0,
      lastPage: null,
    },
  };
}

/**
 * Mescla o que esta gravado com os defaults, inclusive DENTRO de `backfill`.
 *
 * Merge raso nao servia: um registro salvo antes de um campo novo existir trazia o
 * `backfill` inteiro sem ele, e a pagina de opcoes quebrava lendo `undefined.length`
 * — os numeros simplesmente paravam de atualizar.
 */
function mergeMeta(found: Meta | undefined): Meta {
  const base = defaultMeta();
  if (!found) return base;
  return {
    ...base,
    ...found,
    key: META_KEY,
    backfill: { ...base.backfill, ...found.backfill },
  };
}

export async function getMeta(): Promise<Meta> {
  return withTx([STORES.meta], 'readonly', async (tx) => {
    const found = await promisify(
      tx.objectStore(STORES.meta).get(META_KEY) as IDBRequest<Meta | undefined>,
    );
    return mergeMeta(found);
  });
}

/** Patch raso; `backfill` e substituido inteiro quando presente. */
export async function updateMeta(patch: Partial<Omit<Meta, 'key'>>): Promise<Meta> {
  return withTx([STORES.meta], 'readwrite', async (tx) => {
    const store = tx.objectStore(STORES.meta);
    const current = mergeMeta(await promisify(store.get(META_KEY) as IDBRequest<Meta | undefined>));
    const next: Meta = {
      ...current,
      ...patch,
      key: META_KEY,
      backfill: patch.backfill ? { ...current.backfill, ...patch.backfill } : current.backfill,
    };
    if (patch.throttleMs !== undefined) {
      next.throttleMs = Math.max(MIN_THROTTLE_MS, Math.floor(patch.throttleMs) || MIN_THROTTLE_MS);
    }
    store.put(next);
    return next;
  });
}

export async function recordFailure(failure: ParseFailure): Promise<void> {
  await updateMeta({ lastFailure: failure });
}

export async function clearFailure(): Promise<void> {
  await updateMeta({ lastFailure: null });
}

/**
 * Placar "13-8" e o meu time -> vitoria/derrota/empate.
 * Sem placar legivel ou sem saber meu time, devolve null: melhor nao ter o dado.
 */
export function outcomeOf(score: string | null, myTeam: Team | null): Outcome | null {
  if (!score || !myTeam) return null;
  const m = score.match(/^(\d+)-(\d+)$/);
  if (!m?.[1] || !m[2]) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === b) return 'draw';
  return (a > b ? 'A' : 'B') === myTeam ? 'win' : 'loss';
}

function relationOf(team: Team, myTeam: Team | null, wasMe: boolean): Relation {
  if (wasMe) return 'me';
  // Sem eu na partida o parser ja tinha reprovado; o fallback nunca inventa "junto".
  if (myTeam === null) return 'against';
  return team === myTeam ? 'together' : 'against';
}

/**
 * Escrita idempotente de uma partida.
 * Reprocessar a mesma matchId nao duplica nada: as linhas antigas de matchPlayers
 * sao removidas e os contadores dos jogadores afetados sao recalculados do indice.
 */
export async function saveMatch(
  record: MatchRecord,
  source: MatchSource,
  now = Date.now(),
): Promise<{ matchId: string; inserted: boolean; players: number }> {
  const me = record.players.find((p) => p.wasMe);
  const myTeam = me?.team ?? null;

  return withTx(ALL_STORES, 'readwrite', async (tx) => {
    const matches = tx.objectStore(STORES.matches);
    const matchPlayers = tx.objectStore(STORES.matchPlayers);
    const players = tx.objectStore(STORES.players);

    const existing = await promisify(
      matches.get(record.match.matchId) as IDBRequest<Match | undefined>,
    );

    const result = record.match.result ?? outcomeOf(record.match.score, myTeam);
    const match: Match = {
      ...record.match,
      result,
      // Uma partida ja coletada ao vivo nao regride para 'backfill' num reprocessamento.
      source: existing?.source === 'live' ? 'live' : source,
      collectedAt: existing?.collectedAt ?? now,
    };
    matches.put(match);

    // Jogadores tocados: os que ja estavam gravados (podem ter sumido) + os de agora.
    const previous = await getAllByIndex<MatchPlayer>(
      tx,
      STORES.matchPlayers,
      INDEXES.matchPlayers.matchId,
      record.match.matchId,
    );
    const touched = new Set<PlayerId>(previous.map((p) => p.gcId));
    for (const p of previous) matchPlayers.delete([p.matchId, p.gcId]);

    for (const p of record.players) {
      touched.add(p.gcId);
      const row: MatchPlayer = {
        matchId: match.matchId,
        gcId: p.gcId,
        team: p.team,
        levelAtMatch: p.level,
        wasMe: p.wasMe,
        relation: relationOf(p.team, myTeam, p.wasMe),
        playedAt: match.playedAt,
        result,
      };
      if (typeof p.kills === 'number' && typeof p.deaths === 'number') {
        row.kills = p.kills;
        row.deaths = p.deaths;
      }
      matchPlayers.put(row);

      const prevPlayer = await promisify(players.get(p.gcId) as IDBRequest<Player | undefined>);
      players.put(mergePlayer(prevPlayer, p.gcId, p.nick, p.level, match.playedAt, now));
    }

    // Contadores recalculados do indice: sempre consistentes, nunca driftam.
    for (const gcId of touched) {
      const rows = await getAllByIndex<MatchPlayer>(
        tx,
        STORES.matchPlayers,
        INDEXES.matchPlayers.gcId,
        gcId,
      );
      const current = await promisify(players.get(gcId) as IDBRequest<Player | undefined>);
      if (!current) continue;
      if (rows.length === 0) {
        players.delete(gcId);
        continue;
      }
      players.put({ ...current, ...tally(rows) });
    }

    return {
      matchId: match.matchId,
      inserted: existing === undefined,
      players: record.players.length,
    };
  });
}

function tally(rows: MatchPlayer[]) {
  let against = 0;
  let together = 0;
  let wins = 0;
  let losses = 0;
  let draws = 0;
  let lastPlayedAt = 0;
  let lastMatchId: string | null = null;
  let kills = 0;
  let deaths = 0;
  let kdRows = 0;
  const split = {
    together: { win: 0, loss: 0, draw: 0 },
    against: { win: 0, loss: 0, draw: 0 },
  };
  for (const r of rows) {
    if (r.relation === 'against') against += 1;
    else if (r.relation === 'together') together += 1;
    if (r.result === 'win') wins += 1;
    else if (r.result === 'loss') losses += 1;
    else if (r.result === 'draw') draws += 1;
    if (r.result && (r.relation === 'together' || r.relation === 'against')) {
      split[r.relation][r.result] += 1;
    }
    if (typeof r.kills === 'number' && typeof r.deaths === 'number') {
      kills += r.kills;
      deaths += r.deaths;
      kdRows += 1;
    }
    if (r.playedAt >= lastPlayedAt) {
      lastPlayedAt = r.playedAt;
      lastMatchId = r.matchId;
    }
  }
  return {
    totalMatches: rows.length,
    totalAgainst: against,
    totalTogether: together,
    totalWins: wins,
    totalLosses: losses,
    totalDraws: draws,
    totalKills: kills,
    totalDeaths: deaths,
    kdRows,
    togetherWins: split.together.win,
    togetherLosses: split.together.loss,
    togetherDraws: split.together.draw,
    againstWins: split.against.win,
    againstLosses: split.against.loss,
    againstDraws: split.against.draw,
    lastPlayedAt,
    lastMatchId,
  };
}

function mergePlayer(
  prev: Player | undefined,
  gcId: PlayerId,
  nick: string,
  level: number | null,
  playedAt: number,
  now: number,
): Player {
  if (!prev) {
    return {
      gcId,
      nick,
      nickHistory: [{ nick, seenAt: playedAt }],
      lastLevel: level,
      firstSeen: playedAt,
      lastSeen: now,
      totalMatches: 0,
      totalAgainst: 0,
      totalTogether: 0,
      totalWins: 0,
      totalLosses: 0,
      totalDraws: 0,
      lastPlayedAt: playedAt,
      lastMatchId: null,
    };
  }
  // Nick e nivel so avancam com dado mais recente que o ja gravado.
  const newer = playedAt >= prev.lastPlayedAt;
  const nickHistory = prev.nickHistory.some((h) => h.nick === nick)
    ? prev.nickHistory
    : [...prev.nickHistory, { nick, seenAt: playedAt }].sort((a, b) => a.seenAt - b.seenAt);
  return {
    ...prev,
    nick: newer ? nick : prev.nick,
    nickHistory,
    lastLevel: newer ? level : prev.lastLevel,
    firstSeen: Math.min(prev.firstSeen, playedAt),
    lastSeen: Math.max(prev.lastSeen, now),
  };
}

/** Consulta central do overlay. Le so a store players, com contadores prontos. */
export async function getEncounters(gcIds: PlayerId[]): Promise<Map<PlayerId, Encounter>> {
  const out = new Map<PlayerId, Encounter>();
  if (gcIds.length === 0) return out;
  await withTx([STORES.players], 'readonly', async (tx) => {
    const store = tx.objectStore(STORES.players);
    const found = await Promise.all(
      [...new Set(gcIds)].map((id) => promisify(store.get(id) as IDBRequest<Player | undefined>)),
    );
    for (const p of found) {
      if (!p || p.totalMatches === 0) continue;
      out.set(p.gcId, toEncounter(p));
    }
  });
  return out;
}

export interface SharedMatch {
  matchId: string;
  playedAt: number;
  map: string | null;
  score: string | null;
  relation: Relation;
  /** Meu resultado nessa partida. */
  result: Outcome | null;
  /** Nivel que o jogador tinha naquela partida. */
  levelAtMatch: number | null;
}

/** Partidas em comum com um jogador, mais recentes primeiro. Alimenta o mini-painel. */
export async function getSharedMatches(gcId: PlayerId, limit = 20): Promise<SharedMatch[]> {
  return withTx([STORES.matchPlayers, STORES.matches], 'readonly', async (tx) => {
    const rows = await getAllByIndex<MatchPlayer>(
      tx,
      STORES.matchPlayers,
      INDEXES.matchPlayers.gcId,
      gcId,
    );
    rows.sort((a, b) => b.playedAt - a.playedAt);
    const store = tx.objectStore(STORES.matches);
    const out: SharedMatch[] = [];
    for (const r of rows.slice(0, limit)) {
      const m = await promisify(store.get(r.matchId) as IDBRequest<Match | undefined>);
      out.push({
        matchId: r.matchId,
        playedAt: r.playedAt,
        map: m?.map ?? null,
        score: m?.score ?? null,
        relation: r.relation,
        levelAtMatch: r.levelAtMatch,
        // Registro antigo pode nao ter resultado gravado: deriva na hora.
        result: r.result ?? m?.result ?? outcomeOf(m?.score ?? null, myTeamIn(rows, r.matchId)),
      });
    }
    return out;
  });
}

/** Meu time numa partida, a partir das linhas ja carregadas. */
function myTeamIn(rows: MatchPlayer[], matchId: string): Team | null {
  const mine = rows.find((r) => r.matchId === matchId && r.wasMe);
  return mine?.team ?? null;
}

/**
 * Preenche V/D nos registros coletados antes de existir o campo `result`.
 * Roda uma vez (o worker marca `meta.resultsRepairedAt`) e e idempotente.
 */
export async function repairResults(): Promise<{ matches: number; rows: number }> {
  let touchedMatches = 0;
  let touchedRows = 0;

  await withTx([STORES.matches, STORES.matchPlayers], 'readwrite', async (tx) => {
    const matches = tx.objectStore(STORES.matches);
    const all = await promisify(matches.getAll() as IDBRequest<Match[]>);
    for (const m of all) {
      const rows = await getAllByIndex<MatchPlayer>(
        tx,
        STORES.matchPlayers,
        INDEXES.matchPlayers.matchId,
        m.matchId,
      );
      const result = outcomeOf(m.score, rows.find((r) => r.wasMe)?.team ?? null);
      if (m.result !== result) {
        matches.put({ ...m, result });
        touchedMatches += 1;
      }
      const store = tx.objectStore(STORES.matchPlayers);
      for (const r of rows) {
        if (r.result === result) continue;
        store.put({ ...r, result });
        touchedRows += 1;
      }
    }
  });

  await recomputeAllCounters();
  return { matches: touchedMatches, rows: touchedRows };
}

export async function setNote(gcId: PlayerId, note: string): Promise<void> {
  await withTx([STORES.players], 'readwrite', async (tx) => {
    const store = tx.objectStore(STORES.players);
    const p = await promisify(store.get(gcId) as IDBRequest<Player | undefined>);
    if (!p) return;
    const trimmed = note.trim();
    if (trimmed) {
      store.put({ ...p, note: trimmed });
    } else {
      const { note: _dropped, ...rest } = p;
      store.put(rest);
    }
  });
}

export interface DbStats {
  matches: number;
  players: number;
  matchPlayers: number;
  firstMatchAt: number | null;
  lastMatchAt: number | null;
}

export async function getStats(): Promise<DbStats> {
  return withTx([STORES.matches, STORES.players, STORES.matchPlayers], 'readonly', async (tx) => {
    const matches = await promisify(tx.objectStore(STORES.matches).count());
    const players = await promisify(tx.objectStore(STORES.players).count());
    const matchPlayers = await promisify(tx.objectStore(STORES.matchPlayers).count());
    const idx = tx.objectStore(STORES.matches).index(INDEXES.matches.playedAt);
    const first = await promisify(idx.openCursor(null, 'next'));
    const last = await promisify(idx.openCursor(null, 'prev'));
    return {
      matches,
      players,
      matchPlayers,
      firstMatchAt: (first?.value as Match | undefined)?.playedAt ?? null,
      lastMatchAt: (last?.value as Match | undefined)?.playedAt ?? null,
    };
  });
}

/** Ranking de reencontros (fase 4). Eu nao entro no meu proprio ranking. */
export async function getTopEncounters(limit = 20): Promise<Encounter[]> {
  const { myGcId } = await getMeta();
  return withTx([STORES.players], 'readonly', async (tx) => {
    const all = await promisify(tx.objectStore(STORES.players).getAll() as IDBRequest<Player[]>);
    return all
      .filter((p) => p.totalMatches > 0 && p.gcId !== myGcId)
      .sort((a, b) => b.totalMatches - a.totalMatches || b.lastPlayedAt - a.lastPlayedAt)
      .slice(0, limit)
      .map(toEncounter);
  });
}

export async function searchPlayers(query: string, limit = 50): Promise<Encounter[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return withTx([STORES.players], 'readonly', async (tx) => {
    const all = await promisify(tx.objectStore(STORES.players).getAll() as IDBRequest<Player[]>);
    return all
      .filter(
        (p) =>
          p.nick.toLowerCase().includes(q) ||
          String(p.gcId) === q ||
          p.nickHistory.some((h) => h.nick.toLowerCase().includes(q)),
      )
      .sort((a, b) => b.totalMatches - a.totalMatches)
      .slice(0, limit)
      .map(toEncounter);
  });
}

function toEncounter(p: Player): Encounter {
  const wins = p.totalWins ?? 0;
  const losses = p.totalLosses ?? 0;
  const draws = p.totalDraws ?? 0;
  const enc: Encounter = {
    gcId: p.gcId,
    nick: p.nick,
    lastLevel: p.lastLevel,
    total: p.totalMatches,
    against: p.totalAgainst,
    together: p.totalTogether,
    wins,
    losses,
    draws,
    decided: wins + losses + draws,
    kills: p.totalKills ?? 0,
    deaths: p.totalDeaths ?? 0,
    kdRows: p.kdRows ?? 0,
    togetherWins: p.togetherWins ?? 0,
    togetherLosses: p.togetherLosses ?? 0,
    togetherDraws: p.togetherDraws ?? 0,
    againstWins: p.againstWins ?? 0,
    againstLosses: p.againstLosses ?? 0,
    againstDraws: p.againstDraws ?? 0,
    lastPlayedAt: p.lastPlayedAt,
    lastMatchId: p.lastMatchId,
  };
  if (p.note !== undefined) enc.note = p.note;
  return enc;
}

export interface MonthlyResults {
  total: number;
  wins: number;
  losses: number;
  draws: number;
}

/** Partidas por mes ("AAAA-MM", hora local) com meu V/D/E. Alimenta o tooltip da fita. */
export async function getMonthlyResults(): Promise<Map<string, MonthlyResults>> {
  return withTx([STORES.matches], 'readonly', async (tx) => {
    const all = await promisify(tx.objectStore(STORES.matches).getAll() as IDBRequest<Match[]>);
    const out = new Map<string, MonthlyResults>();
    for (const m of all) {
      const d = new Date(m.playedAt);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const cur = out.get(key) ?? { total: 0, wins: 0, losses: 0, draws: 0 };
      cur.total += 1;
      if (m.result === 'win') cur.wins += 1;
      else if (m.result === 'loss') cur.losses += 1;
      else if (m.result === 'draw') cur.draws += 1;
      out.set(key, cur);
    }
    return out;
  });
}

export interface DbDump {
  format: 'gc-encounters';
  schemaVersion: number;
  exportedAt: number;
  players: Player[];
  matches: Match[];
  matchPlayers: MatchPlayer[];
  meta: Meta;
}

export async function exportAll(): Promise<DbDump> {
  return withTx(ALL_STORES, 'readonly', async (tx) => ({
    format: 'gc-encounters' as const,
    schemaVersion: LATEST_VERSION,
    exportedAt: Date.now(),
    players: await promisify(tx.objectStore(STORES.players).getAll() as IDBRequest<Player[]>),
    matches: await promisify(tx.objectStore(STORES.matches).getAll() as IDBRequest<Match[]>),
    matchPlayers: await promisify(
      tx.objectStore(STORES.matchPlayers).getAll() as IDBRequest<MatchPlayer[]>,
    ),
    meta: await getMetaIn(tx),
  }));
}

async function getMetaIn(tx: IDBTransaction): Promise<Meta> {
  return mergeMeta(
    await promisify(tx.objectStore(STORES.meta).get(META_KEY) as IDBRequest<Meta | undefined>),
  );
}

/** Import aditivo: registros homonimos sao sobrescritos, o resto e preservado. */
export async function importAll(dump: DbDump): Promise<{ matches: number; players: number }> {
  if (dump?.format !== 'gc-encounters') throw new Error('arquivo nao e um export do gc-encounters');
  if (dump.schemaVersion > LATEST_VERSION) {
    throw new Error('export gerado por uma versao mais nova da extensao');
  }
  await withTx(ALL_STORES, 'readwrite', async (tx) => {
    for (const m of dump.matches) tx.objectStore(STORES.matches).put(m);
    for (const mp of dump.matchPlayers) tx.objectStore(STORES.matchPlayers).put(mp);
    for (const p of dump.players) tx.objectStore(STORES.players).put(p);
  });
  await recomputeAllCounters();
  return { matches: dump.matches.length, players: dump.players.length };
}

export async function recomputeAllCounters(): Promise<void> {
  await withTx([STORES.players, STORES.matchPlayers], 'readwrite', async (tx) => {
    const players = tx.objectStore(STORES.players);
    const all = await promisify(players.getAll() as IDBRequest<Player[]>);
    for (const p of all) {
      const rows = await getAllByIndex<MatchPlayer>(
        tx,
        STORES.matchPlayers,
        INDEXES.matchPlayers.gcId,
        p.gcId,
      );
      players.put({ ...p, ...tally(rows) });
    }
  });
}

export async function wipe(): Promise<void> {
  await withTx(ALL_STORES, 'readwrite', async (tx) => {
    for (const s of ALL_STORES) tx.objectStore(s).clear();
  });
}

export async function hasMatch(matchId: string): Promise<boolean> {
  return withTx([STORES.matches], 'readonly', async (tx) => {
    const key = await promisify(
      tx.objectStore(STORES.matches).getKey(matchId) as IDBRequest<IDBValidKey | undefined>,
    );
    return key !== undefined;
  });
}

export async function getKnownMatchIds(): Promise<Set<string>> {
  return withTx([STORES.matches], 'readonly', async (tx) => {
    const keys = await promisify(
      tx.objectStore(STORES.matches).getAllKeys() as IDBRequest<IDBValidKey[]>,
    );
    return new Set(keys.map(String));
  });
}

// ---------------------------------------------------------------------------
// Mapas e agregador. Tudo derivado de matchPlayers + matches na hora da consulta:
// nada novo e desnormalizado, entao nao ha contador para driftar nem migracao.
// ---------------------------------------------------------------------------

export interface MapStat {
  /** Nome como a GC grava (`de_mirage`); `null` quando a partida nao trouxe mapa. */
  map: string | null;
  played: number;
  wins: number;
  losses: number;
  draws: number;
  /** Kills/deaths somados nas partidas desse mapa que trouxeram o dado (`kdRows`). */
  kills: number;
  deaths: number;
  kdRows: number;
}

function emptyMapStat(map: string | null): MapStat {
  return { map, played: 0, wins: 0, losses: 0, draws: 0, kills: 0, deaths: 0, kdRows: 0 };
}

function addOutcome(s: { wins: number; losses: number; draws: number }, o: Outcome | null): void {
  if (o === 'win') s.wins += 1;
  else if (o === 'loss') s.losses += 1;
  else if (o === 'draw') s.draws += 1;
}

/** Mais jogado primeiro; empate no total desempata pelo nome, mapa desconhecido por ultimo. */
function sortMaps(maps: Iterable<MapStat>): MapStat[] {
  return [...maps].sort(
    (a, b) =>
      b.played - a.played ||
      Number(a.map === null) - Number(b.map === null) ||
      (a.map ?? '').localeCompare(b.map ?? ''),
  );
}

/** Embate por mapa: V/D sao MEUS contra o jogador; kills/deaths sao dele, `my*` sao meus. */
export interface DuelMapStat extends MapStat {
  myKills: number;
  myDeaths: number;
  myKdRows: number;
}

export interface PlayerMaps {
  /** Todas as partidas gravadas do jogador, com o resultado dele (placar + time em que jogou). */
  all: MapStat[];
  /** So as partidas no meu time: o resultado dele e o meu. */
  together: MapStat[];
  /** So as partidas em times opostos, do meu ponto de vista. */
  against: DuelMapStat[];
}

/**
 * Mapas de um jogador, separados por relacao comigo. Para mim `all` e o historico
 * inteiro e os recortes ficam vazios; para os outros so existem partidas que cruzaram comigo.
 */
export async function getPlayerMaps(gcId: PlayerId): Promise<PlayerMaps> {
  const { myGcId } = await getMeta();
  return withTx([STORES.matchPlayers, STORES.matches], 'readonly', async (tx) => {
    const rows = await getAllByIndex<MatchPlayer>(
      tx,
      STORES.matchPlayers,
      INDEXES.matchPlayers.gcId,
      gcId,
    );
    const matchStore = tx.objectStore(STORES.matches);
    const mpStore = tx.objectStore(STORES.matchPlayers);
    const [matches, mine] = await Promise.all([
      Promise.all(rows.map((r) => promisify(matchStore.get(r.matchId) as IDBRequest<Match | undefined>))),
      // Minha linha so importa nos embates: e dela que sai o meu K/D contra ele.
      Promise.all(
        rows.map((r) =>
          r.relation === 'against' && myGcId !== null
            ? promisify(mpStore.get([r.matchId, myGcId]) as IDBRequest<MatchPlayer | undefined>)
            : Promise.resolve(undefined),
        ),
      ),
    ]);

    const all = new Map<string | null, MapStat>();
    const together = new Map<string | null, MapStat>();
    const against = new Map<string | null, DuelMapStat>();
    const hasKd = (r: MatchPlayer | undefined): r is MatchPlayer & { kills: number; deaths: number } =>
      typeof r?.kills === 'number' && typeof r.deaths === 'number';
    const add = (s: MapStat, o: Outcome | null, r: MatchPlayer) => {
      s.played += 1;
      addOutcome(s, o);
      if (hasKd(r)) {
        s.kills += r.kills;
        s.deaths += r.deaths;
        s.kdRows += 1;
      }
    };

    rows.forEach((r, i) => {
      const m = matches[i];
      const key = m?.map ?? null;
      const score = m?.score ?? null;
      const own = outcomeOf(score, r.team);

      const a = all.get(key) ?? emptyMapStat(key);
      add(a, own, r);
      all.set(key, a);

      if (r.relation === 'together') {
        const t = together.get(key) ?? emptyMapStat(key);
        add(t, own, r);
        together.set(key, t);
      } else if (r.relation === 'against') {
        const d = against.get(key) ?? { ...emptyMapStat(key), myKills: 0, myDeaths: 0, myKdRows: 0 };
        add(d, outcomeOf(score, r.team === 'A' ? 'B' : 'A'), r);
        const me = mine[i];
        if (hasKd(me)) {
          d.myKills += me.kills;
          d.myDeaths += me.deaths;
          d.myKdRows += 1;
        }
        against.set(key, d);
      }
    });

    return {
      all: sortMaps(all.values()),
      together: sortMaps(together.values()),
      against: sortMaps(against.values()) as DuelMapStat[],
    };
  });
}

/** `team`: so partidas com todos no mesmo time. `match`: qualquer partida com todos em campo. */
export type GroupMode = 'team' | 'match';

/** Jogadores escolhidos no agregador. Eu entro por fora, sempre: o teto da consulta e MAX_GROUP + 1. */
export const MAX_GROUP = 4;

export interface GroupLine {
  gcId: PlayerId;
  team: Team;
  level: number | null;
  /** Resultado do proprio jogador nessa partida. */
  result: Outcome | null;
  kills: number | null;
  deaths: number | null;
}

export interface GroupMatch {
  matchId: string;
  playedAt: number;
  map: string | null;
  score: string | null;
  /** Todos os escolhidos no mesmo time. */
  sameTeam: boolean;
  /** Resultado do grupo; so existe quando `sameTeam`. */
  result: Outcome | null;
  lines: GroupLine[];
}

export interface GroupPlayer {
  gcId: PlayerId;
  nick: string;
  lastLevel: number | null;
  played: number;
  wins: number;
  losses: number;
  draws: number;
  kills: number;
  deaths: number;
  kdRows: number;
}

export interface GroupStats {
  mode: GroupMode;
  /** Na ordem em que foram escolhidos. */
  players: GroupPlayer[];
  /** Mais recentes primeiro. */
  matches: GroupMatch[];
  /** Quantas das partidas tiveram todos no mesmo time (base do V/D do grupo). */
  sameTeam: number;
  wins: number;
  losses: number;
  draws: number;
  /** Mapas das partidas do grupo; V/D do grupo, K/D somado dos escolhidos. */
  maps: MapStat[];
}

/**
 * Partidas gravadas em que TODOS os jogadores escolhidos estavam em campo.
 * O banco so tem partidas minhas, entao "todas" = todas que a extensao viu.
 */
export async function getGroupStats(gcIds: PlayerId[], mode: GroupMode = 'team'): Promise<GroupStats> {
  const ids = [...new Set(gcIds)].slice(0, MAX_GROUP + 1);
  const out: GroupStats = {
    mode,
    players: [],
    matches: [],
    sameTeam: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    maps: [],
  };
  if (ids.length === 0) return out;

  return withTx([STORES.matchPlayers, STORES.matches, STORES.players], 'readonly', async (tx) => {
    const playerStore = tx.objectStore(STORES.players);
    const [rowsBy, found] = await Promise.all([
      Promise.all(
        ids.map((id) =>
          getAllByIndex<MatchPlayer>(tx, STORES.matchPlayers, INDEXES.matchPlayers.gcId, id),
        ),
      ),
      Promise.all(ids.map((id) => promisify(playerStore.get(id) as IDBRequest<Player | undefined>))),
    ]);

    out.players = ids.map((gcId, i) => ({
      gcId,
      nick: found[i]?.nick ?? `#${gcId}`,
      lastLevel: found[i]?.lastLevel ?? null,
      played: 0,
      wins: 0,
      losses: 0,
      draws: 0,
      kills: 0,
      deaths: 0,
      kdRows: 0,
    }));

    const byMatch = rowsBy.map((rows) => new Map(rows.map((r) => [r.matchId, r])));
    const [first, ...rest] = byMatch;
    if (!first) return out;
    const shared = [...first.keys()].filter((id) => rest.every((m) => m.has(id)));

    const matchStore = tx.objectStore(STORES.matches);
    const records = await Promise.all(
      shared.map((id) => promisify(matchStore.get(id) as IDBRequest<Match | undefined>)),
    );

    const maps = new Map<string | null, MapStat>();
    shared.forEach((matchId, i) => {
      const rows = byMatch.map((m) => m.get(matchId)!);
      const sameTeam = rows.every((r) => r.team === rows[0]!.team);
      if (mode === 'team' && !sameTeam) return;

      const m = records[i];
      const score = m?.score ?? null;
      const lines: GroupLine[] = rows.map((r) => ({
        gcId: r.gcId,
        team: r.team,
        level: r.levelAtMatch,
        result: outcomeOf(score, r.team),
        kills: typeof r.kills === 'number' ? r.kills : null,
        deaths: typeof r.deaths === 'number' ? r.deaths : null,
      }));
      const result = sameTeam ? (lines[0]?.result ?? null) : null;

      const mapKey = m?.map ?? null;
      const ms = maps.get(mapKey) ?? emptyMapStat(mapKey);
      ms.played += 1;
      addOutcome(ms, result);

      lines.forEach((l, p) => {
        const s = out.players[p]!;
        s.played += 1;
        addOutcome(s, l.result);
        if (l.kills !== null && l.deaths !== null) {
          s.kills += l.kills;
          s.deaths += l.deaths;
          s.kdRows += 1;
          ms.kills += l.kills;
          ms.deaths += l.deaths;
          ms.kdRows += 1;
        }
      });
      maps.set(mapKey, ms);

      if (sameTeam) out.sameTeam += 1;
      addOutcome(out, result);
      out.matches.push({
        matchId,
        playedAt: rows[0]!.playedAt,
        map: mapKey,
        score,
        sameTeam,
        result,
        lines,
      });
    });

    out.matches.sort((a, b) => b.playedAt - a.playedAt);
    out.maps = sortMaps(maps.values());
    return out;
  });
}
