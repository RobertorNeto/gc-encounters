/**
 * Camada de seletores candidatos — o único ponto do código que sabe como a GC
 * desenha as páginas. Quando o site mudar, só este arquivo e os fixtures mudam.
 *
 * Confirmado na Fase 0 (21/09/2026) para a página de partida
 * `gamersclub.com.br/lobby/partida/<id>`: markup BEM, sem `data-*`, sem __NEXT_DATA__,
 * sem endpoint JSON com o elenco — a fonte é o HTML renderizado.
 *
 * Cada lista é tentada em ordem e a primeira que retornar resultado vence; nenhuma
 * retornando nada é falha explícita, nunca dado inventado (spec §9.4).
 */

/** Links de perfil: fonte canônica do id estável da GC. */
export const PLAYER_LINK = 'a[href*="/jogador/"], a[href*="/player/"]';
export const PLAYER_ID_RE = /\/(?:jogador|player)\/(\d+)/;

/** Links/rotas de partida. */
export const MATCH_LINK = 'a[href*="/partida/"], a[href*="/match/"]';
export const MATCH_ID_RE = /\/(?:partida|match)\/([\w-]+)/;

/** Containers candidatos de um jogador dentro de um placar/lista. */
export const PLAYER_ROW_CANDIDATES = [
  'tr.PlayerStatsLine', // confirmado
  '[data-player-id]',
  '[class*="player-row"]',
  '[class*="playerRow"]',
  'tr',
  'li',
];

/** Blocos candidatos que agrupam um time inteiro. A ordem define time A e time B. */
export const TEAM_BLOCK_CANDIDATES = [
  'table.PlayerStatsTable', // confirmado: duas tabelas, 5 jogadores cada
  '[data-team]',
  '[class*="team-players"]',
  '[class*="teamPlayers"]',
  '[class*="team-box"]',
  'table tbody',
];

/** Onde procurar o nível do jogador dentro da linha dele. */
export const LEVEL_CANDIDATES = [
  'span[class*="gcf-badge-level-"]', // confirmado: a própria classe carrega o número
  '[class*="gcf-badge-level"]',
  '[data-level]',
  '[class*="level"] img[alt]',
  'img[src*="level"]',
  '[class*="level"]',
];

/** `gcf-badge-level-16` -> 16. Mais confiável que o texto, que pode vir vazio. */
export const LEVEL_CLASS_RE = /gcf-badge-level-(\d+)/;

/**
 * Kills e deaths dentro da linha do jogador. Não confirmados na Fase 0: a sonda não
 * olhou as colunas de stats. Só aceita célula cuja classe nomeia a estatística e cujo
 * texto é um inteiro; qualquer dúvida vira `null`, nunca número inventado.
 */
export const KILL_CANDIDATES = [
  '[data-kills]',
  '[class*="__kills" i]',
  '[class*="__kill" i]',
  '[class*="kills" i]',
];
export const DEATH_CANDIDATES = [
  '[data-deaths]',
  '[class*="__deaths" i]',
  '[class*="__death" i]',
  '[class*="deaths" i]',
];

/** O mapa vem como imagem (`img.MatchResultInfo__map`), não como texto. */
export const MAP_CANDIDATES = [
  'img.MatchResultInfo__map', // confirmado
  '[data-map]',
  '[class*="map-name"]',
  '[class*="mapName"]',
];

/** Último recurso: o nome do mapa aparece solto no texto da página. */
export const MAP_TEXT_RE = /de_[a-z0-9_]+/i;

/** Onde procurar o placar. */
export const SCORE_CANDIDATES = [
  '.MatchResultInfo__scoreBox', // confirmado: texto "13vs8"
  '[data-score]',
  '[class*="score"]',
  '[class*="placar"]',
];

/**
 * Onde procurar a data/hora da partida.
 * Confirmado: a página usa blocos rótulo/valor (DATA, DURAÇÃO, MAPA...) e a data cai
 * num `p.MatchResultInfo__blockText`. Como o rótulo não é marcado, o parser varre os
 * blocos e fica com o primeiro que realmente parseia como data.
 */
export const DATE_CANDIDATES = [
  'time[datetime]',
  '[data-date]',
  '.MatchResultInfo__blockText', // confirmado
  '[class*="date"]',
  '[class*="data"]',
];

/** Link do próprio usuário no cabeçalho, para descobrir `meta.myGcId`. */
export const ME_LINK_CANDIDATES = [
  'header a[href*="/jogador/"]',
  '[class*="user-menu"] a[href*="/jogador/"]',
  '[class*="userMenu"] a[href*="/jogador/"]',
  '[class*="avatar"] a[href*="/jogador/"]',
];

/** Nós a observar antes de considerar a página renderizada. */
export const READY_HINTS = {
  match: [PLAYER_LINK],
  myMatches: [MATCH_LINK],
  lobby: [PLAYER_LINK],
};

/** Paginação do histórico — preencher após a Fase 0. */
export const PAGINATION = {
  /** Se a lista pagina por query param, o nome dele. */
  pageParam: 'page' as string | null,
  nextButtonCandidates: ['[rel="next"]', '[class*="next"]', 'button[aria-label*="próxima"]'],
};
