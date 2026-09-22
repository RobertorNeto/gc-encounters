/**
 * Adaptador dos endpoints JSON internos da GC — a fonte primária (spec §4.2).
 *
 * Confirmado na Fase 0 (21/09/2026):
 *   GET /lobby/match/<id>/1                          -> dados da partida
 *   GET /players/get_playerLobbyResults/<per>/<pag>  -> histórico ("latest" ou "2026-09")
 *
 * São os mesmos endpoints que o próprio site chama, na mesma origem e na mesma
 * sessão do usuário. Nada de header forjado, nada de WebSocket: o socket da GC é
 * comunicação com os servidores dela e não se toca nele.
 *
 * Extração pura: nada aqui faz fetch nem escreve no banco.
 */
import { fail, ok, SKIP, type Result } from '@/lib/result';
import type { MatchRecord, PlayerId, Team } from '@/types';
import { parseGcDate, type ParseContext } from './parser';

export const matchApiPath = (matchId: string): string =>
  `/lobby/match/${encodeURIComponent(matchId)}/1`;

/** `period` é "latest" ou "AAAA-MM"; `page` começa em 1. */
export const historyApiPath = (period: string, page: number): string =>
  `/players/get_playerLobbyResults/${encodeURIComponent(period)}/${page}`;

/** Endpoint do usuario logado — e por aqui que o "meu id" e descoberto sozinho. */
export const USER_ME_PATH = '/api/v1/user/me';

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null;

/** A API devolve números como string ("13", "481049"). */
function toInt(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null;
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

function toStr(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (typeof v === 'number') return String(v);
  return null;
}

interface RawStats {
  idplayer?: unknown;
  level?: unknown;
  player_room?: unknown;
  player?: unknown;
  [key: string]: unknown;
}

/**
 * Nomes candidatos para kills/deaths no bloco de stats. O nome real nao foi
 * confirmado na Fase 0 (a sonda so olhou id, nick, nivel e time); se nenhum casar,
 * o campo fica `null` e o K/D simplesmente nao aparece. Nunca se inventa numero.
 */
const KILL_KEYS = ['nb_kill', 'nb_kills', 'kills', 'kill', 'k'] as const;
const DEATH_KEYS = ['nb_death', 'nb_deaths', 'deaths', 'death', 'd'] as const;

function pickInt(row: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const k of keys) {
    const v = toInt(row[k]);
    if (v !== null && v >= 0) return v;
  }
  return null;
}

/**
 * Uma linha de `jogos.players.team_x`. O nível relevante é o do bloco de stats
 * (nível NA partida), não o `player.level`, que é o nível atual do jogador.
 *
 * Tolerante de propósito: a fonte é o JSON estruturado da própria GC, não HTML
 * raspado. Linha sem id é a única coisa que não dá para aproveitar (`null`);
 * nick ausente vira `#id` e é corrigido na próxima partida em que o nick vier.
 * O time é o da lista (`team_a`/`team_b`), que é como a GC exibe a partida.
 */
function readPlayer(raw: unknown, team: Team, ctx: ParseContext): MatchRecord['players'][number] | null {
  if (!isObj(raw)) return null;
  const row = raw as RawStats;
  const profile = isObj(row.player) ? row.player : null;

  const gcId = toInt(row.idplayer) ?? (profile ? toInt(profile['id']) : null);
  if (gcId === null) return null;

  const nick =
    (profile ? toStr(profile['nick']) ?? toStr(profile['nickname']) ?? toStr(profile['name']) : null) ??
    `#${gcId}`;

  const out: MatchRecord['players'][number] = {
    gcId: gcId as PlayerId,
    nick,
    team,
    level: toInt(row.level),
    wasMe: gcId === ctx.myGcId,
  };
  const kills = pickInt(row, KILL_KEYS);
  const deaths = pickInt(row, DEATH_KEYS);
  // So grava K/D quando os dois vieram: um sem o outro nao vira razao.
  if (kills !== null && deaths !== null) {
    out.kills = kills;
    out.deaths = deaths;
  }
  return out;
}

/** `/lobby/match/<id>/1` -> MatchRecord. */
export function parseMatchApi(input: unknown, ctx: ParseContext): Result<MatchRecord> {
  if (!isObj(input)) return fail('api:root', 'resposta nao e objeto');
  if (input['success'] === false) {
    return fail('api:success', toStr(input['message']) ?? 'API respondeu success=false');
  }

  const matchId = toStr(input['id']) ?? ctx.matchId ?? null;
  if (!matchId) return fail('api:id', 'id da partida ausente');

  const playedAt = parseGcDate(toStr(input['data']));
  if (playedAt === null) return fail('api:date', `data ilegivel: ${String(input['data'])}`);

  const jogos = input['jogos'];
  if (!isObj(jogos)) return fail('api:jogos', 'bloco jogos ausente');
  const players = jogos['players'];
  if (!isObj(players)) return fail('api:players', 'bloco jogos.players ausente');

  const teams: [Team, unknown][] = [
    ['A', players['team_a']],
    ['B', players['team_b']],
  ];

  // Tudo que a GC listar entra. Partida com substituicoes passa de 10 jogadores
  // com folga (15+ acontece); jogador que trocou de lado aparece nas duas listas e
  // fica com a primeira aparicao; time ausente na resposta nao invalida o resto.
  // O objetivo e bater 1:1 com o historico que a GC mostra.
  const out: MatchRecord['players'] = [];
  const seen = new Set<PlayerId>();
  for (const [team, list] of teams) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const parsed = readPlayer(raw, team, ctx);
      if (!parsed || seen.has(parsed.gcId)) continue;
      seen.add(parsed.gcId);
      out.push(parsed);
    }
  }
  if (out.length === 0) return fail('api:players', 'nenhum jogador legivel na resposta');

  if (ctx.myGcId === null) {
    return fail(`${SKIP}sem-meu-id`, 'meu id GC ainda nao esta definido nas opcoes');
  }
  // Partida de outra pessoa (link de convite, perfil alheio): ignorar, nao falhar.
  if (!out.some((p) => p.wasMe)) {
    return fail(`${SKIP}nao-e-minha`, 'nao joguei esta partida');
  }

  const scoreA = toInt(jogos['score_a']);
  const scoreB = toInt(jogos['score_b']);

  return ok({
    match: {
      matchId,
      playedAt,
      map: toStr(jogos['map_name']),
      score: scoreA !== null && scoreB !== null ? `${scoreA}-${scoreB}` : null,
    },
    players: out,
  });
}

export interface HistoryPage {
  matchIds: string[];
  /** Períodos disponíveis ("2026-09", "2026-08"...), do mais recente ao mais antigo. */
  periods: string[];
  currentPage: number;
  lastPage: number | null;
  myGcId: PlayerId | null;
}

/** Extrai o id da partida de um item da lista, seja qual for o campo que o carrega. */
function matchIdOf(item: unknown): string | null {
  if (!isObj(item)) return null;
  for (const key of ['idlobby_game', 'idlobby', 'id_lobby', 'idmatch', 'id']) {
    const v = toStr(item[key]);
    if (v && /^\d+$/.test(v)) return v;
  }
  const link = toStr(item['link']) ?? toStr(item['url']);
  const fromLink = link?.match(/\/lobby\/(?:match|partida)\/(\d+)/)?.[1];
  return fromLink ?? null;
}

/** `/players/get_playerLobbyResults/<per>/<pag>` -> ids + paginação. */
export function parseHistoryApi(input: unknown): Result<HistoryPage> {
  if (!isObj(input)) return fail('api:root', 'resposta nao e objeto');
  if (input['success'] === false) {
    return fail('api:success', toStr(input['message']) ?? 'API respondeu success=false');
  }

  const lista = input['lista'] ?? input['data'];
  if (!Array.isArray(lista)) return fail('api:lista', 'lista de partidas ausente');

  const matchIds: string[] = [];
  for (const item of lista) {
    const id = matchIdOf(item);
    if (id && !matchIds.includes(id)) matchIds.push(id);
  }
  if (matchIds.length === 0 && lista.length > 0) {
    return fail('api:lista', 'itens sem id de partida reconhecivel');
  }

  const periods: string[] = [];
  const selectDates = input['selectDates'];
  if (Array.isArray(selectDates)) {
    for (const d of selectDates) {
      const url = isObj(d) ? toStr(d['dataURL']) : null;
      if (url) periods.push(url);
    }
  }

  const pag = isObj(input['pagination']) ? input['pagination'] : {};
  const currentUser = isObj(input['currentUser']) ? input['currentUser'] : null;

  return ok({
    matchIds,
    periods,
    currentPage: toInt(pag['current_page']) ?? toInt(pag['currentPage']) ?? 1,
    // Confirmado: { total: "28", pages_total: 3, current_page: "1" }
    lastPage: toInt(pag['pages_total']) ?? toInt(pag['last_page']) ?? toInt(pag['total_pages']) ?? null,
    myGcId: currentUser ? (toInt(currentUser['id']) ?? toInt(currentUser['idplayer'])) : null,
  });
}

export interface MeInfo {
  gcId: PlayerId;
  nick: string | null;
  /** Nivel atual, se o endpoint trouxer no mesmo no do id. `null` quando nao traz. */
  level: number | null;
}

const ME_LEVEL_KEYS = ['level', 'nivel', 'skill_level', 'skillLevel', 'player_level', 'playerLevel'] as const;

/**
 * `/api/v1/user/me` -> meu id GC.
 *
 * O shape exato desse endpoint nao foi mapeado na Fase 0, entao a busca e por
 * formato e nao por caminho fixo: procura, em profundidade curta, um objeto que
 * tenha id numerico plausivel junto de um nick. Nao achou, falha — nao chuta.
 */
export function parseUserMe(input: unknown): Result<MeInfo> {
  if (!isObj(input)) return fail('api:me-root', 'resposta nao e objeto');

  const seen = new Set<unknown>();
  const visit = (node: unknown, depth: number): MeInfo | null => {
    if (depth > 4 || !isObj(node) || seen.has(node)) return null;
    seen.add(node);

    const gcId = toInt(node['id']) ?? toInt(node['idplayer']) ?? toInt(node['player_id']);
    const nick = toStr(node['nick']) ?? toStr(node['nickname']) ?? toStr(node['username']);
    // Id de jogador da GC tem 4+ digitos; id de plano/medalha nao acompanha nick.
    if (gcId !== null && gcId > 1000 && nick) {
      let level: number | null = null;
      for (const key of ME_LEVEL_KEYS) {
        const raw = node[key];
        // Pode vir como numero, string ou objeto { level: 14 }.
        const v = isObj(raw) ? toInt(raw['level']) ?? toInt(raw['value']) : toInt(raw);
        if (v !== null && v >= 0 && v <= 30) {
          level = v;
          break;
        }
      }
      return { gcId, nick, level };
    }

    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value.slice(0, 5)) {
          const found = visit(item, depth + 1);
          if (found) return found;
        }
        continue;
      }
      const found = visit(value, depth + 1);
      if (found) return found;
    }
    return null;
  };

  const me = visit(input, 0);
  return me ? ok(me) : fail('api:me-shape', 'nao encontrei id + nick na resposta');
}
