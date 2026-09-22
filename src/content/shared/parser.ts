/**
 * Extração pura: (HTML | JSON) -> MatchRecord. Sem IndexedDB, sem chrome.*, sem fetch.
 * Toda a fragilidade do projeto mora aqui e em selectors.ts.
 *
 * Princípio (spec §9.4): melhor não ter o dado do que ter dado inventado. Qualquer
 * campo obrigatório ausente reprova a partida inteira; nada parcial é gravado.
 */
import { allMatches, firstInt, firstMatch, text } from './dom';
import {
  DATE_CANDIDATES,
  DEATH_CANDIDATES,
  KILL_CANDIDATES,
  LEVEL_CANDIDATES,
  LEVEL_CLASS_RE,
  MAP_CANDIDATES,
  MAP_TEXT_RE,
  MATCH_ID_RE,
  MATCH_LINK,
  ME_LINK_CANDIDATES,
  PLAYER_ID_RE,
  PLAYER_LINK,
  PLAYER_ROW_CANDIDATES,
  SCORE_CANDIDATES,
  TEAM_BLOCK_CANDIDATES,
} from './selectors';
import { fail, ok, SKIP, type Result } from '@/lib/result';
import type { MatchRecord, PlayerId, Team } from '@/types';

/** Uma partida GC é 5v5. Fora dessa faixa, algo foi lido errado. */
/**
 * Faixa de sanidade so para o caminho HTML (markup raspado pode casar lixo).
 * Folgada: partida com muitas substituicoes passa de 15 jogadores.
 */
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 40;

export interface ParseContext {
  /** Id do dono da coleta. Sem ele não dá para dizer "contra" ou "junto". */
  myGcId: PlayerId | null;
  matchId?: string | undefined;
  url?: string | undefined;
  now?: number | undefined;
}

export function extractPlayerId(href: string | null | undefined): PlayerId | null {
  const m = href?.match(PLAYER_ID_RE);
  return m?.[1] ? Number(m[1]) : null;
}

export function extractMatchId(href: string | null | undefined): string | null {
  const m = href?.match(MATCH_ID_RE);
  return m?.[1] ?? null;
}

/** Id do usuário logado, lido do link do próprio perfil no cabeçalho. */
export function detectMyGcId(root: ParentNode): PlayerId | null {
  const el = firstMatch(root, ME_LINK_CANDIDATES);
  return extractPlayerId(el?.getAttribute('href'));
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

interface RawPlayer {
  gcId: PlayerId;
  nick: string;
  level: number | null;
  kills?: number;
  deaths?: number;
}

/**
 * Sobe do link do jogador até a linha inteira dele — é lá que mora o nível.
 * Usa os candidatos de linha em ordem; o primeiro ancestral que casar vence.
 */
function rowOf(link: Element): Element {
  for (const sel of PLAYER_ROW_CANDIDATES) {
    const row = link.closest(sel);
    if (row) return row;
  }
  return link.parentElement ?? link;
}

function readLevel(row: Element): number | null {
  const el = firstMatch(row, LEVEL_CANDIDATES);
  if (!el) return null;
  const fromClass = el.getAttribute('class')?.match(LEVEL_CLASS_RE)?.[1];
  if (fromClass) return Number(fromClass);
  return (
    firstInt(el.getAttribute('data-level')) ??
    firstInt(el.getAttribute('alt')) ??
    firstInt(el.getAttribute('src')) ??
    firstInt(text(el))
  );
}

/** Inteiro >= 0 de uma célula de stat; qualquer outra coisa é `null`. */
function readStat(row: Element, candidates: string[]): number | null {
  const el = firstMatch(row, candidates);
  if (!el) return null;
  const raw = el.getAttribute('data-kills') ?? el.getAttribute('data-deaths') ?? text(el);
  if (!raw || !/^\d{1,3}$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

function readPlayersIn(root: ParentNode): RawPlayer[] {
  const out = new Map<PlayerId, RawPlayer>();
  for (const link of root.querySelectorAll(PLAYER_LINK)) {
    const gcId = extractPlayerId(link.getAttribute('href'));
    if (gcId === null) continue;
    const row = rowOf(link);
    const nick = text(link) || text(row).slice(0, 40);
    if (!nick) continue; // sem nick não grava: registro parcial é proibido
    const existing = out.get(gcId);
    if (existing && existing.level !== null) continue;
    const player: RawPlayer = { gcId, nick, level: readLevel(row) };
    const kills = readStat(row, KILL_CANDIDATES);
    const deaths = readStat(row, DEATH_CANDIDATES);
    if (kills !== null && deaths !== null) {
      player.kills = kills;
      player.deaths = deaths;
    }
    out.set(gcId, player);
  }
  return [...out.values()];
}

/** Blocos que contêm jogadores; a ordem no DOM define time A e time B. */
function findTeamBlocks(root: ParentNode): Element[] {
  for (const sel of TEAM_BLOCK_CANDIDATES) {
    const blocks = [...root.querySelectorAll(sel)].filter(
      (b) => b.querySelectorAll(PLAYER_LINK).length > 0,
    );
    // Descarta blocos aninhados: fica só o mais externo de cada ramo.
    const outer = blocks.filter((b) => !blocks.some((o) => o !== b && o.contains(b)));
    if (outer.length === 2) return outer;
  }
  return [];
}

/** Varre os candidatos e fica com o primeiro que parseia de fato — o resto é ruído. */
function parseDate(root: ParentNode): number | null {
  for (const sel of DATE_CANDIDATES) {
    for (const el of root.querySelectorAll(sel)) {
      const raw = el.getAttribute('datetime') ?? el.getAttribute('data-date') ?? text(el);
      const parsed = parseGcDate(raw);
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

/** Aceita ISO e o `dd/mm/yyyy [hh:mm]` que a GC usa em pt-BR. */
export function parseGcDate(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const br = raw.match(/(\d{2})\/(\d{2})\/(\d{4})(?:[ ,]+(\d{2}):(\d{2}))?/);
  if (br) {
    const [, d, mo, y, h, mi] = br;
    return new Date(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(h ?? 0),
      Number(mi ?? 0),
    ).getTime();
  }
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : t;
}

/** Parser da página de uma partida finalizada. */
export function parseMatchDom(root: ParentNode, ctx: ParseContext): Result<MatchRecord> {
  const matchId = ctx.matchId ?? extractMatchId(ctx.url);
  if (!matchId) return fail('match:id', 'matchId ausente na URL');

  const blocks = findTeamBlocks(root);
  if (blocks.length !== 2) {
    return fail('match:teams', `esperava 2 blocos de time, achei ${blocks.length}`);
  }

  const seen = new Set<PlayerId>();
  const players: MatchRecord['players'] = [];
  const teams: Team[] = ['A', 'B'];
  for (const [i, block] of blocks.entries()) {
    const team = teams[i] as Team;
    for (const p of readPlayersIn(block)) {
      if (seen.has(p.gcId)) continue; // mesmo id nos dois times = leitura errada
      seen.add(p.gcId);
      players.push({ ...p, team, wasMe: p.gcId === ctx.myGcId });
    }
  }

  const check = validatePlayers(players, ctx.myGcId);
  if (!check.ok) return check;

  const playedAt = parseDate(root);
  if (playedAt === null) return fail('match:date', 'data da partida nao encontrada');

  return ok({
    match: {
      matchId,
      playedAt,
      map: readMap(root),
      score: readScore(root),
    },
    players,
  });
}

/** Aceita "13vs8", "13 x 8", "16-14". Sem dois números, devolve null. */
function readScore(root: ParentNode): string | null {
  const el = firstMatch(root, SCORE_CANDIDATES);
  const raw = el?.getAttribute('data-score') ?? text(el);
  const m = raw?.match(/(\d{1,2})\s*(?:vs|x|-|:)\s*(\d{1,2})/i);
  return m ? `${m[1]}-${m[2]}` : null;
}

/**
 * O mapa é uma imagem, não texto: vem de `alt`, `title` ou do nome do arquivo.
 * Só depois cai para o nome solto no texto da página.
 */
function readMap(root: ParentNode): string | null {
  const el = firstMatch(root, MAP_CANDIDATES);
  if (el) {
    const candidates = [
      el.getAttribute('data-map'),
      el.getAttribute('alt'),
      el.getAttribute('title'),
      el.getAttribute('src'),
      text(el),
    ];
    for (const raw of candidates) {
      const found = raw?.match(MAP_TEXT_RE)?.[0];
      if (found) return found.toLowerCase();
    }
  }
  const inText = (root instanceof Document ? root.body : root)?.textContent?.match(MAP_TEXT_RE);
  return inText ? inText[0].toLowerCase() : null;
}

function validatePlayers(players: MatchRecord['players'], myGcId: PlayerId | null): Result<null> {
  if (players.length < MIN_PLAYERS) {
    return fail('match:players', `apenas ${players.length} jogadores lidos`);
  }
  if (players.length > MAX_PLAYERS) {
    return fail('match:players', `${players.length} jogadores — leitura suspeita`);
  }
  const teamsPresent = new Set(players.map((p) => p.team));
  if (teamsPresent.size !== 2) return fail('match:teams', 'jogadores todos no mesmo time');
  if (myGcId === null) {
    return fail(`${SKIP}sem-meu-id`, 'meu id GC ainda nao esta definido nas opcoes');
  }
  if (!players.some((p) => p.wasMe)) {
    return fail(`${SKIP}nao-e-minha`, 'nao joguei esta partida');
  }
  return ok(null);
}

/** Lista de partidas do histórico + cursor da próxima página. */
export function parseMyMatchesDom(
  root: ParentNode,
  currentUrl?: string,
): Result<{ matchIds: string[]; links: { matchId: string; href: string }[]; nextCursor: string | null }> {
  const byId = new Map<string, string>();
  for (const a of root.querySelectorAll(MATCH_LINK)) {
    const href = a.getAttribute('href');
    const matchId = extractMatchId(href);
    if (matchId && href && !byId.has(matchId)) byId.set(matchId, href);
  }
  if (byId.size === 0) return fail('list:matches', 'nenhum link de partida na pagina');
  return ok({
    matchIds: [...byId.keys()],
    links: [...byId].map(([matchId, href]) => ({ matchId, href })),
    nextCursor: nextPageCursor(root, currentUrl),
  });
}

function nextPageCursor(root: ParentNode, currentUrl?: string): string | null {
  const next = allMatches(root, ['[rel="next"]', 'a[class*="next"]'])[0];
  const href = next?.getAttribute('href');
  if (href) return href;
  if (!currentUrl) return null;
  try {
    const url = new URL(currentUrl);
    const page = Number(url.searchParams.get('page') ?? '1');
    if (!Number.isFinite(page)) return null;
    url.searchParams.set('page', String(page + 1));
    return url.pathname + url.search;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

/**
 * Nomes de campo aceitos no payload interno. Preencher com os nomes REAIS após a
 * Fase 0 — não é para adivinhar: se nenhum candidato casar, o parse reprova.
 */
export const JSON_FIELDS = {
  players: ['players', 'jogadores', 'participants', 'lineup'],
  id: ['id', 'user_id', 'userId', 'player_id', 'playerId', 'gcId'],
  nick: ['nick', 'nickname', 'username', 'name'],
  level: ['level', 'nivel', 'gcLevel'],
  team: ['team', 'time', 'side', 'teamId'],
  matchId: ['id', 'match_id', 'matchId'],
  playedAt: ['date', 'played_at', 'playedAt', 'created_at', 'createdAt', 'finished_at'],
  map: ['map', 'mapa', 'map_name', 'mapName'],
  score: ['score', 'placar', 'result'],
  kills: ['nb_kill', 'nb_kills', 'kills', 'kill'],
  deaths: ['nb_death', 'nb_deaths', 'deaths', 'death'],
} as const;

type Json = Record<string, unknown>;

function pick(obj: Json, keys: readonly string[]): unknown {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

function asInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string') return firstInt(v);
  return null;
}

/** Normaliza o identificador de time em 'A' | 'B' sem inventar lado. */
function asTeam(v: unknown, order: Map<string, Team>): Team | null {
  if (v === undefined || v === null) return null;
  const key = String(v).trim().toLowerCase();
  if (!key) return null;
  const known = order.get(key);
  if (known) return known;
  if (order.size >= 2) return null; // mais de dois times = leitura errada
  const team: Team = order.size === 0 ? 'A' : 'B';
  order.set(key, team);
  return team;
}

/** Parser do payload interno da partida. Fonte primária quando existir (spec §4.2). */
export function parseMatchJson(input: unknown, ctx: ParseContext): Result<MatchRecord> {
  if (typeof input !== 'object' || input === null) return fail('json:root', 'payload nao e objeto');
  const root = input as Json;
  const body = (pick(root, ['match', 'data', 'result']) as Json | undefined) ?? root;

  const rawPlayers = pick(body, JSON_FIELDS.players);
  if (!Array.isArray(rawPlayers)) return fail('json:players', 'lista de jogadores nao encontrada');

  const matchId = ctx.matchId ?? stringOrNull(pick(body, JSON_FIELDS.matchId));
  if (!matchId) return fail('json:id', 'matchId ausente no payload');

  const playedAt = parseGcDate(stringOrNull(pick(body, JSON_FIELDS.playedAt))) ?? epochOf(pick(body, JSON_FIELDS.playedAt));
  if (playedAt === null) return fail('json:date', 'data da partida ausente no payload');

  const order = new Map<string, Team>();
  const seen = new Set<PlayerId>();
  const players: MatchRecord['players'] = [];
  for (const entry of rawPlayers) {
    if (typeof entry !== 'object' || entry === null) continue;
    const p = entry as Json;
    const gcId = asInt(pick(p, JSON_FIELDS.id));
    const nick = stringOrNull(pick(p, JSON_FIELDS.nick));
    const team = asTeam(pick(p, JSON_FIELDS.team), order);
    if (gcId === null || !nick || team === null) {
      return fail('json:player', `campo obrigatorio ausente em um jogador (id=${gcId})`);
    }
    if (seen.has(gcId)) continue;
    seen.add(gcId);
    const player: MatchRecord['players'][number] = {
      gcId,
      nick,
      level: asInt(pick(p, JSON_FIELDS.level)),
      team,
      wasMe: gcId === ctx.myGcId,
    };
    const kills = asInt(pick(p, JSON_FIELDS.kills));
    const deaths = asInt(pick(p, JSON_FIELDS.deaths));
    if (kills !== null && deaths !== null && kills >= 0 && deaths >= 0) {
      player.kills = kills;
      player.deaths = deaths;
    }
    players.push(player);
  }

  const check = validatePlayers(players, ctx.myGcId);
  if (!check.ok) return check;

  return ok({
    match: {
      matchId: String(matchId),
      playedAt,
      map: stringOrNull(pick(body, JSON_FIELDS.map)),
      score: normalizeScore(pick(body, JSON_FIELDS.score)),
    },
    players,
  });
}

function stringOrNull(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (typeof v === 'number') return String(v);
  return null;
}

function epochOf(v: unknown): number | null {
  const n = asInt(v);
  if (n === null) return null;
  // Segundos vs milissegundos: timestamps GC em segundos têm 10 dígitos.
  return n < 1e11 ? n * 1000 : n;
}

function normalizeScore(v: unknown): string | null {
  const s = stringOrNull(v);
  const m = s?.match(/(\d{1,2})\s*[x\-:]\s*(\d{1,2})/i);
  return m ? `${m[1]}-${m[2]}` : null;
}
