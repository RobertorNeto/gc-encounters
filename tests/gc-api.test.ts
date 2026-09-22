/**
 * Testes dos adaptadores de API, sobre FIXTURES REAIS (spec §8).
 *
 * Para popular: no console da GC, logado,
 *   await (await fetch('/lobby/match/<id>/1')).json()          -> match-<id>.json
 *   await (await fetch('/players/get_playerLobbyResults/latest/1')).json() -> history-latest.json
 * e salvar em tests/fixtures/. Sem fixture, o bloco fica declaradamente pendente.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  historyApiPath,
  matchApiPath,
  parseHistoryApi,
  parseMatchApi,
  parseUserMe,
} from '@/content/shared/gc-api';
import { isSkip } from '@/lib/result';

const DIR = join(__dirname, 'fixtures');
const files = existsSync(DIR) ? readdirSync(DIR) : [];
const matchFixtures = files.filter((f) => /^match-\d+\.json$/.test(f));
const historyFixtures = files.filter((f) => /^history-.*\.json$/.test(f));
const read = (f: string): unknown => JSON.parse(readFileSync(join(DIR, f), 'utf8'));

describe('rotas da API', () => {
  it('monta os caminhos confirmados na Fase 0', () => {
    expect(matchApiPath('27915278')).toBe('/lobby/match/27915278/1');
    expect(historyApiPath('latest', 1)).toBe('/players/get_playerLobbyResults/latest/1');
    expect(historyApiPath('2026-09', 3)).toBe('/players/get_playerLobbyResults/2026-09/3');
  });
});

const describeMatch = matchFixtures.length ? describe : describe.skip;
describeMatch('parseMatchApi (fixture real)', () => {
  for (const file of matchFixtures) {
    const raw = matchFixtures.length ? (read(file) as Record<string, any>) : null;
    const matchId = file.replace(/^match-|\.json$/g, '');
    // O dono do fixture é quem aparece com hasCurrentPlayerInMatch; pegamos um id real dele.
    const myGcId = Number(raw?.jogos?.players?.team_a?.[0]?.idplayer);

    it(`extrai ${file} inteiro`, () => {
      const res = parseMatchApi(raw, { myGcId, matchId });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.value.match.matchId).toBe(matchId);
      expect(res.value.match.playedAt).toBeGreaterThan(0);
      expect(res.value.match.map).toMatch(/^de_|^cs_/);
      expect(res.value.match.score).toMatch(/^\d{1,2}-\d{1,2}$/);

      expect(res.value.players).toHaveLength(10);
      expect(res.value.players.filter((p) => p.team === 'A')).toHaveLength(5);
      expect(res.value.players.filter((p) => p.team === 'B')).toHaveLength(5);
      expect(res.value.players.filter((p) => p.wasMe)).toHaveLength(1);
      expect(new Set(res.value.players.map((p) => p.gcId)).size).toBe(10);
      for (const p of res.value.players) {
        expect(p.nick).not.toBe('');
        expect(Number.isInteger(p.gcId)).toBe(true);
      }
    });

    it(`pula ${file} quando eu não joguei a partida`, () => {
      const res = parseMatchApi(raw, { myGcId: -1, matchId });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      // "pular" e diferente de "quebrar": nao vira alerta nem falha de backfill.
      expect(res.stage).toBe('skip:nao-e-minha');
      expect(isSkip(res)).toBe(true);
    });

    it(`usa o nível DA partida, não o nível atual do perfil`, () => {
      const res = parseMatchApi(raw, { myGcId, matchId });
      if (!res.ok) throw new Error(res.reason);
      const first = raw?.jogos?.players?.team_a?.[0];
      const parsed = res.value.players.find((p) => p.gcId === Number(first.idplayer));
      expect(parsed?.level).toBe(Number(first.level));
    });
  }
});

describe('parseMatchApi — recusas', () => {
  it('rejeita resposta que não é objeto', () => {
    const res = parseMatchApi('nada', { myGcId: 1 });
    expect(res.ok).toBe(false);
  });

  it('rejeita success=false com a mensagem da API', () => {
    const res = parseMatchApi({ success: false, message: 'sem permissao' }, { myGcId: 1 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('sem permissao');
  });

  it('player_room discordando da lista nao derruba a partida: vale a lista', () => {
    const res = parseMatchApi(
      {
        id: '1',
        data: '21/09/2026 00:26',
        jogos: {
          score_a: '13',
          score_b: '8',
          map_name: 'de_cache',
          players: {
            team_a: [{ idplayer: '1', player_room: 'b', player: { nick: 'x' } }],
            team_b: [{ idplayer: '2', player_room: 'b', player: { nick: 'y' } }],
          },
        },
      },
      { myGcId: 1 },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.players.find((p) => p.gcId === 1)?.team).toBe('A');
    expect(res.value.players.find((p) => p.gcId === 2)?.team).toBe('B');
  });

  it('linha sem id e descartada; nick ausente vira #id; jogador nas duas listas fica na primeira', () => {
    const res = parseMatchApi(
      {
        id: '1',
        data: '21/09/2026 00:26',
        jogos: {
          score_a: '13',
          score_b: '8',
          players: {
            team_a: [{ idplayer: '1', player: { nick: 'eu' } }, { idplayer: '3' }, { player: { nick: 'fantasma' } }],
            team_b: [{ idplayer: '2', player: { nick: 'y' } }, { idplayer: '3', player: { nick: 'trocou' } }],
          },
        },
      },
      { myGcId: 1 },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.players.map((p) => p.gcId).sort()).toEqual([1, 2, 3]);
    const three = res.value.players.find((p) => p.gcId === 3);
    expect(three).toMatchObject({ nick: '#3', team: 'A' });
  });
});

const describeHistory = historyFixtures.length ? describe : describe.skip;
describeHistory('parseHistoryApi (fixture real)', () => {
  for (const file of historyFixtures) {
    it(`lê ids e paginação de ${file}`, () => {
      const res = parseHistoryApi(read(file));
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.matchIds.length).toBeGreaterThan(0);
      expect(new Set(res.value.matchIds).size).toBe(res.value.matchIds.length);
      expect(res.value.currentPage).toBeGreaterThanOrEqual(1);
      for (const p of res.value.periods) expect(p).toMatch(/^\d{4}-\d{2}$/);
    });
  }
});

describe('parseHistoryApi — forma confirmada na Fase 0', () => {
  const sample = {
    success: true,
    selectDates: [
      { dataFormatada: '09/2026', dataURL: '2026-09' },
      { dataFormatada: '08/2026', dataURL: '2026-08' },
    ],
    lista: [{ idlobby_game: '27915278' }, { idlobby_game: '27914973' }],
    pagination: { total: '28', pages_total: 3, current_page: '1' },
    currentUser: { nick: 'Ntzk1', id: '1885415', level: 18 },
  };

  it('lê ids, meses, paginação e meu id', () => {
    const res = parseHistoryApi(sample);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.matchIds).toEqual(['27915278', '27914973']);
    expect(res.value.periods).toEqual(['2026-09', '2026-08']);
    expect(res.value.currentPage).toBe(1);
    expect(res.value.lastPage).toBe(3);
    expect(res.value.myGcId).toBe(1885415);
  });

  it('não inventa id quando o item não tem nenhum campo reconhecível', () => {
    const res = parseHistoryApi({ ...sample, lista: [{ nb_kill: '10' }] });
    expect(res.ok).toBe(false);
  });

  it('aceita histórico vazio sem falhar', () => {
    const res = parseHistoryApi({ ...sample, lista: [] });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.matchIds).toEqual([]);
  });
});

if (matchFixtures.length === 0) {
  describe('fixtures da API', () => {
    it.skip('pendente: salvar match-<id>.json em tests/fixtures/ (ver RECON.md)', () => {});
  });
}

describe('partida de outra pessoa não polui o tracker', () => {
  const alheia = {
    id: '27920439',
    data: '21/09/2026 12:00',
    jogos: {
      score_a: '13',
      score_b: '10',
      map_name: 'de_mirage',
      players: {
        team_a: [
          { idplayer: '11', player_room: 'a', level: '10', player: { nick: 'a1' } },
          { idplayer: '12', player_room: 'a', level: '10', player: { nick: 'a2' } },
        ],
        team_b: [
          { idplayer: '21', player_room: 'b', level: '10', player: { nick: 'b1' } },
          { idplayer: '22', player_room: 'b', level: '10', player: { nick: 'b2' } },
        ],
      },
    },
  };

  it('pula quando meu id não está no elenco', () => {
    const res = parseMatchApi(alheia, { myGcId: 1885415 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(isSkip(res)).toBe(true);
    expect(res.stage).toBe('skip:nao-e-minha');
  });

  it('pula, em vez de falhar, quando meu id nem está configurado', () => {
    const res = parseMatchApi(alheia, { myGcId: null });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(isSkip(res)).toBe(true);
    expect(res.stage).toBe('skip:sem-meu-id');
  });

  it('coleta normalmente quando eu estou no elenco', () => {
    const res = parseMatchApi(alheia, { myGcId: 12 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.players.find((p) => p.wasMe)?.gcId).toBe(12);
  });

  it('defeito de verdade continua sendo falha, não skip', () => {
    const quebrada = { ...alheia, jogos: { ...alheia.jogos, players: {} } };
    const res = parseMatchApi(quebrada, { myGcId: 12 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(isSkip(res)).toBe(false);
    expect(res.stage).toBe('api:players');
  });
});

describe('tamanho do elenco', () => {
  const base = (teamA: unknown[], teamB: unknown[]) => ({
    id: '1',
    data: '21/09/2026 00:26',
    jogos: {
      score_a: '13',
      score_b: '8',
      map_name: 'de_cache',
      players: { team_a: teamA, team_b: teamB },
    },
  });
  const p = (id: number, room: 'a' | 'b') => ({
    idplayer: String(id),
    player_room: room,
    level: '10',
    player: { nick: `n${id}` },
  });

  it('aceita 11 jogadores: substituição no meio da partida é dado real', () => {
    const teamA = [1, 2, 3, 4, 5, 6].map((i) => p(i, 'a'));
    const teamB = [7, 8, 9, 10, 11].map((i) => p(i, 'b'));
    const res = parseMatchApi(base(teamA, teamB), { myGcId: 1 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.players).toHaveLength(11);
  });

  it('aceita 18 jogadores: partida cheia de substituicoes e dado real da GC', () => {
    const teamA = Array.from({ length: 9 }, (_, i) => p(i + 1, 'a'));
    const teamB = Array.from({ length: 9 }, (_, i) => p(i + 20, 'b'));
    const res = parseMatchApi(base(teamA, teamB), { myGcId: 1 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.players).toHaveLength(18);
  });

  it('sem nenhum jogador legivel, reprova', () => {
    const res = parseMatchApi(base([{ player: { nick: 'x' } }], []), { myGcId: 1 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.stage).toBe('api:players');
  });
});

describe('parseMatchApi: kills e deaths', () => {
  const row = (id: number, room: 'a' | 'b', extra: Record<string, unknown> = {}) => ({
    idplayer: String(id),
    player_room: room,
    level: '10',
    player: { nick: `n${id}` },
    ...extra,
  });
  const base = (teamA: unknown[], teamB: unknown[]) => ({
    id: '1',
    data: '21/09/2026 00:26',
    jogos: { score_a: '13', score_b: '8', map_name: 'de_mirage', players: { team_a: teamA, team_b: teamB } },
  });

  it('le nb_kill/nb_death como string, como a API devolve', () => {
    const teamA = [row(1, 'a', { nb_kill: '21', nb_death: '17' }), ...[3, 4, 5, 6].map((i) => row(i, 'a'))];
    const teamB = [row(2, 'b', { nb_kill: 17, nb_death: 21 }), ...[7, 8, 9, 10].map((i) => row(i, 'b'))];
    const res = parseMatchApi(base(teamA, teamB), { myGcId: 1 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const byId = (id: number) => res.value.players.find((p) => p.gcId === id);
    expect(byId(1)).toMatchObject({ gcId: 1, kills: 21, deaths: 17 });
    expect(byId(2)).toMatchObject({ gcId: 2, kills: 17, deaths: 21 });
    expect(byId(3)).not.toHaveProperty('kills');
  });

  it('sem os dois campos, nao inventa: kills/deaths ficam ausentes', () => {
    const teamA = [row(1, 'a', { nb_kill: '21' }), ...[3, 4, 5, 6].map((i) => row(i, 'a'))];
    const teamB = [2, 7, 8, 9, 10].map((i) => row(i, 'b'));
    const res = parseMatchApi(base(teamA, teamB), { myGcId: 1 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    for (const p of res.value.players) {
      expect(p).not.toHaveProperty('kills');
      expect(p).not.toHaveProperty('deaths');
    }
  });
});

describe('parseUserMe', () => {
  it('acha id, nick e nivel no no do usuario, mesmo aninhado', () => {
    const res = parseUserMe({
      success: true,
      data: { plan: { id: 3, name: 'premium' }, user: { id: '1885415', nick: 'rbcorneto', level: '14' } },
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ gcId: 1885415, nick: 'rbcorneto', level: 14 });
  });

  it('sem nivel no payload, devolve null em vez de chutar', () => {
    const res = parseUserMe({ id: 1885415, nickname: 'rb' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ gcId: 1885415, nick: 'rb', level: null });
  });
});
