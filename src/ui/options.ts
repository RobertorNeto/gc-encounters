/**
 * Página de opções. Roda na origem da extensão, então fala com o IndexedDB direto —
 * é o mesmo banco do service worker.
 */
import { MAX_CONSECUTIVE_FAILURES, MIN_THROTTLE_MS } from '@/config/constants';
import {
  exportAll,
  getEncounters,
  getGroupStats,
  getMeta,
  getMonthlyResults,
  getPlayerMapStats,
  getSharedMatches,
  getStats,
  getTopEncounters,
  importAll,
  recomputeAllCounters,
  repairResults,
  searchPlayers,
  updateMeta,
  wipe,
  MAX_GROUP,
  type DbDump,
  type GroupMatch,
  type GroupMode,
  type GroupStats,
  type MapStat,
  type MonthlyResults,
  type SharedMatch,
} from '@/db/repo';
import { log } from '@/lib/log';
import { send } from '@/lib/messages';
import type { BackfillState, Encounter } from '@/types';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`elemento ausente: ${id}`);
  return el as T;
};

const fmtInt = (n: number): string => n.toLocaleString('pt-BR');

const fmtDate = (ms: number | null): string =>
  ms ? new Date(ms).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : 'ainda não';

const fmtDay = (ms: number): string =>
  new Date(ms).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' });

/** "2026-05" -> "mai 2026". */
function fmtPeriod(period: string): string {
  const [y, m] = period.split('-').map(Number);
  if (!y || !m) return period;
  const label = new Date(y, m - 1, 1).toLocaleDateString('pt-BR', { month: 'short' });
  return `${label.replace('.', '')} ${y}`;
}

/** "2026-05" -> "maio de 2026", para o tooltip. */
function fmtPeriodLong(period: string): string {
  const [y, m] = period.split('-').map(Number);
  if (!y || !m) return period;
  const label = new Date(y, m - 1, 1).toLocaleDateString('pt-BR', { month: 'long' });
  return `${label} de ${y}`;
}

/**
 * Troca o texto e pisca o elemento quando o valor mudou. E o feedback de que a
 * varredura esta andando: o numero muda na sua frente.
 */
function setText(el: HTMLElement, text: string): void {
  if (el.textContent === text) return;
  el.textContent = text;
  el.classList.remove('tick');
  void el.offsetWidth; // reinicia a animacao
  el.classList.add('tick');
}

// ---------------------------------------------------------------------------
// Assets da GC: avatar por id e badge de nivel. Mesmos servidores que o site usa;
// sao subdominios de gamersclub.com.br, dentro da regra "zero rede externa".
// ---------------------------------------------------------------------------

const avatarUrl = (gcId: number): string =>
  `https://static.gamersclub.com.br/players/avatar/${gcId}/${gcId}_medium.jpg`;

const levelIconUrl = (level: number): string =>
  `https://gcv1-assets.gamersclub.com.br/assets/images/level/${level}.svg`;

/** Cores oficiais dos niveis (CSS da GC, `.gcf-badge-level-N`). Fallback se o SVG falhar. */
const LEVEL_COLORS = [
  '#58597a', '#643284', '#5c2d84', '#532883', '#492381', '#402686', '#2d3a8a',
  '#2967b0', '#2967b0', '#2a7bc2', '#2a8acc', '#3e9cb7', '#53a18b', '#68a761',
  '#7cac35', '#91b20a', '#bdb700', '#f0bc00', '#f89a06', '#f46e12', '#eb2f2f', '#ff00c0',
];

function levelBadge(level: number, small = false): HTMLElement {
  const lvl = Math.max(0, Math.min(LEVEL_COLORS.length - 1, Math.trunc(level)));
  const el = document.createElement('span');
  el.className = small ? 'lvl sm' : 'lvl';
  el.title = `nível ${lvl}`;
  el.style.setProperty('--lvl', LEVEL_COLORS[lvl] ?? LEVEL_COLORS[0]!);
  const img = document.createElement('img');
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.addEventListener('error', () => {
    img.remove();
    el.classList.add('no-img');
  });
  img.src = levelIconUrl(lvl);
  const num = document.createElement('span');
  num.textContent = String(lvl);
  el.append(img, num);
  return el;
}

const hueOf = (gcId: number): number => Math.round((gcId * 137.508) % 360);

const profileUrl = (gcId: number): string => `https://gamersclub.com.br/player/${gcId}`;

/** Kills por death, com uma casa a mais que a GC mostra para nao empatar tudo em 1.0. */
function kdText(kills: number, deaths: number): string {
  const kd = deaths === 0 ? kills : kills / deaths;
  return kd.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Verde de 1.00 para cima, vermelho abaixo. */
const kdTone = (kills: number, deaths: number): 'good' | 'bad' =>
  (deaths === 0 ? kills : kills / deaths) >= 1 ? 'good' : 'bad';

function profileLink(gcId: number, label = 'Abrir perfil na GC'): HTMLAnchorElement {
  const a = document.createElement('a');
  a.className = 'profile-link';
  a.href = profileUrl(gcId);
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = label;
  a.addEventListener('click', (ev) => ev.stopPropagation());
  return a;
}

function avatar(gcId: number, nick: string, el = document.createElement('span')): HTMLElement {
  el.classList.add('avatar');
  el.classList.remove('has-img');
  el.style.setProperty('--hue', String(hueOf(gcId)));
  el.textContent = (nick.trim()[0] ?? '?').toUpperCase();
  const img = document.createElement('img');
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.addEventListener('load', () => el.classList.add('has-img'));
  img.addEventListener('error', () => img.remove());
  img.src = avatarUrl(gcId);
  el.append(img);
  return el;
}

// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<BackfillState['status'], string> = {
  idle: 'não iniciada',
  running: 'rodando em segundo plano',
  paused: 'pausada',
  done: 'concluída',
  error: 'parada após falhas seguidas',
};

const LIVE_LABEL: Record<BackfillState['status'], string> = {
  idle: 'Varredura parada',
  running: 'Varredura rodando',
  paused: 'Varredura pausada',
  done: 'Histórico completo',
  error: 'Varredura com erro',
};

function statusSubtitle(bf: BackfillState): string {
  switch (bf.status) {
    case 'running':
      return bf.cursor ? `Lendo ${fmtPeriod(bf.cursor)}. Pode fechar a GC.` : 'Descobrindo os meses do histórico.';
    case 'paused':
      return bf.cursor ? `Parou em ${fmtPeriod(bf.cursor)}. Retoma de onde estava.` : 'Retoma de onde estava.';
    case 'done':
      return 'Todo o histórico que a GC lista já foi lido.';
    case 'error':
      return 'Entre na GC de novo e retome. A sessão provavelmente expirou.';
    default:
      return 'Nenhuma varredura iniciada.';
  }
}

/** Busca ativa na lista de reencontros. Vazia = ranking. */
let query = '';

/** Total de partidas no ultimo refresh; -1 antes do primeiro. */
let lastMatchCount = -1;

async function refresh(): Promise<void> {
  const [stats, meta, monthly] = await Promise.all([getStats(), getMeta(), getMonthlyResults()]);

  setText($('stat-matches'), fmtInt(stats.matches));
  setText($('stat-players'), fmtInt(stats.players));
  setText($('stat-rows'), fmtInt(stats.matchPlayers));
  setText($('stat-first'), fmtDate(stats.firstMatchAt));
  setText($('stat-last'), fmtDate(stats.lastMatchAt));
  setText($('stat-me'), meta.myGcId ? `#${meta.myGcId}` : 'não definido');
  $('identity').classList.toggle('needs-setup', !meta.myGcId);

  const myId = $('my-id') as HTMLInputElement;
  if (document.activeElement !== myId) myId.value = meta.myGcId ? String(meta.myGcId) : '';

  await renderMe(meta.myGcId);
  renderBackfill(meta.backfill, monthly);

  const throttle = $('throttle') as HTMLInputElement;
  if (document.activeElement !== throttle) throttle.value = String(meta.throttleMs);

  renderAlert(meta.lastFailure);

  // Partida nova, import ou wipe: o agregador refaz a conta. Fora isso fica parado,
  // senao o tick de 2 s fecharia a lista de partidas que o usuario esta lendo.
  if (stats.matches !== lastMatchCount) {
    const first = lastMatchCount === -1;
    lastMatchCount = stats.matches;
    if (!first) void renderGroup();
  }

  // Com busca ativa a lista pertence a busca; o tick nao a substitui pelo ranking.
  if (!query) renderList($('top'), await getTopEncounters(20), { ranked: true });
}

/**
 * Meu perfil: avatar e nivel da GC, totais de V/D e K/D calculados do que ja foi
 * gravado. Eu tambem sou uma linha em `players` (tally roda para todo mundo da
 * partida), entao `getEncounters([meu id])` devolve meus proprios totais.
 */
async function renderMe(myGcId: number | null): Promise<void> {
  const box = $('identity');
  const avatarEl = $('me-avatar');
  const nick = $('me-nick');
  const level = $('me-level');
  const sub = $('me-sub');
  const stats = $('me-stats');
  const link = $('me-link') as HTMLAnchorElement;

  $('me-maps').hidden = !myGcId;

  if (!myGcId) {
    avatarEl.hidden = true;
    delete box.dataset.gcId;
    delete box.dataset.level;
    level.textContent = '';
    link.hidden = true;
    stats.hidden = true;
    setText(nick, 'Quem é você na GC');
    if (!sub.textContent?.trim()) {
      sub.textContent =
        'Sem o seu id a extensão não sabe se você jogou contra ou junto, então nada é gravado até ele estar preenchido.';
    }
    return;
  }

  const [encounters, meta] = await Promise.all([getEncounters([myGcId]), getMeta()]);
  const me = encounters.get(myGcId) ?? null;
  // Antes da primeira partida gravada, nick e nivel vem da deteccao pela sessao.
  const myNick = me?.nick ?? meta.myNick ?? null;

  if (box.dataset.gcId !== String(myGcId)) {
    box.dataset.gcId = String(myGcId);
    avatar(myGcId, myNick ?? '?', avatarEl);
    avatarEl.hidden = false;
    link.href = profileUrl(myGcId);
    link.hidden = false;
  }
  setText(nick, myNick ?? `#${myGcId}`);

  const lvl = me?.lastLevel ?? meta.myLevel ?? null;
  if (box.dataset.level !== String(lvl)) {
    box.dataset.level = String(lvl);
    level.textContent = '';
    if (lvl !== null) level.append(levelBadge(lvl));
  }

  if (!me) {
    stats.hidden = true;
    sub.textContent = myNick
      ? `Id #${myGcId} salvo. Os totais aparecem quando a primeira partida sua for gravada.`
      : `Id #${myGcId} salvo. Nick e nível chegam com "Detectar pela sessão" ou com a primeira partida gravada.`;
    return;
  }

  sub.textContent = '';
  stats.hidden = false;
  setText($('me-total'), fmtInt(me.total));
  setText($('me-wins'), fmtInt(me.wins));
  setText($('me-losses'), fmtInt(me.losses));
  $('me-losses').title = me.draws ? `${fmtInt(me.draws)} empates` : '';
  setText($('me-rate'), me.decided ? `${Math.round((me.wins / me.decided) * 100)}%` : 'sem placar');

  const kd = $('me-kd');
  kd.classList.remove('is-good', 'is-bad');
  if (me.kdRows > 0) {
    setText(kd, kdText(me.kills, me.deaths));
    kd.classList.remove('is-muted');
    kd.classList.add(kdTone(me.kills, me.deaths) === 'good' ? 'is-good' : 'is-bad');
    kd.title =
      me.kdRows < me.total
        ? `${fmtInt(me.kills)} kills, ${fmtInt(me.deaths)} deaths em ${fmtInt(me.kdRows)} de ${fmtInt(me.total)} partidas. As outras foram gravadas antes do K/D existir.`
        : `${fmtInt(me.kills)} kills, ${fmtInt(me.deaths)} deaths`;
  } else {
    setText(kd, 'sem dado');
    kd.classList.add('is-muted');
    kd.title = 'K/D só vem das partidas coletadas a partir de agora.';
  }
}

function renderBackfill(bf: BackfillState, monthly: Map<string, MonthlyResults>): void {
  $('engine').dataset.state = bf.status;
  $('live').dataset.state = bf.status;
  setText($('live-label'), LIVE_LABEL[bf.status]);
  setText($('bf-title'), STATUS_LABEL[bf.status]);
  setText($('bf-sub'), statusSubtitle(bf));

  setText($('bf-collected'), fmtInt(bf.matchesDone));
  setText($('bf-pages'), fmtInt(bf.pagesDone));
  setText($('bf-queue'), fmtInt(bf.queue.length));
  const fail = $('bf-fail');
  setText(fail, `${bf.consecutiveFailures} de ${MAX_CONSECUTIVE_FAILURES}`);
  fail.classList.toggle('is-bad', bf.consecutiveFailures > 0);

  ($('bf-start') as HTMLButtonElement).disabled = bf.status === 'running';
  ($('bf-pause') as HTMLButtonElement).disabled = bf.status !== 'running';

  renderTape(bf, monthly);
  renderFailed(bf);

  const detail = bf.lastPage
    ? `Última página lida: ${fmtPeriod(bf.lastPage.period)}, página ${bf.lastPage.page}, ` +
      `${bf.lastPage.found} partidas na lista, ${bf.lastPage.fresh} novas. ` +
      `${bf.emptyMonths} meses vazios seguidos.`
    : '';
  setText($('backfill-status'), detail);
}

/** Traduz o estagio da falha para algo que o usuario entende. */
function failureLabel(stage: string, reason: string): string {
  if (stage.startsWith('skip:nao-e-minha')) return 'meu id não está no elenco que a GC devolveu';
  if (stage.startsWith('skip:sem-meu-id')) return 'meu id não estava definido na hora';
  if (stage === 'fetch') return `requisição falhou: ${reason}`;
  return `${stage}: ${reason}`;
}

const FAILED_SHOWN = 8;

/** Lista de partidas que a varredura nao conseguiu ler, com botao para reler so elas. */
function renderFailed(bf: BackfillState): void {
  const failed = bf.failed ?? [];
  const box = $('bf-failed');
  box.hidden = failed.length === 0;
  if (box.hidden) return;

  setText(
    $('bf-failed-title'),
    `${fmtInt(failed.length)} ${failed.length === 1 ? 'partida não entrou' : 'partidas não entraram'}`,
  );
  const queued = new Set(bf.queue);
  const retrying = bf.status === 'running' && failed.some((f) => queued.has(f.matchId));
  ($('bf-retry') as HTMLButtonElement).disabled = retrying;

  const list = $('bf-failed-list');
  const signature = failed.map((f) => `${f.matchId}:${f.stage}`).join('|');
  if (list.dataset.signature === signature) return;
  list.dataset.signature = signature;
  list.textContent = '';
  for (const f of [...failed].sort((a, b) => b.at - a.at).slice(0, FAILED_SHOWN)) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `https://gamersclub.com.br/lobby/match/${f.matchId}`;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = `#${f.matchId}`;
    const why = document.createElement('span');
    why.textContent = failureLabel(f.stage, f.reason);
    why.title = `${f.stage}: ${f.reason} (${fmtDate(f.at)})`;
    li.append(a, why);
    list.append(li);
  }
  if (failed.length > FAILED_SHOWN) {
    const li = document.createElement('li');
    li.className = 'more';
    li.textContent = `e mais ${fmtInt(failed.length - FAILED_SHOWN)}`;
    list.append(li);
  }
}

/** "12 partidas, 7V 4D 1E" ou "sem partidas gravadas". */
function monthSummary(m: MonthlyResults | undefined): string {
  if (!m || m.total === 0) return 'sem partidas gravadas';
  const parts = [`${m.wins}V`, `${m.losses}D`];
  if (m.draws) parts.push(`${m.draws}E`);
  const unknown = m.total - m.wins - m.losses - m.draws;
  if (unknown > 0) parts.push(`${unknown} sem placar`);
  return `${m.total} ${m.total === 1 ? 'partida' : 'partidas'}, ${parts.join(' ')}`;
}

/** Fita de meses agrupada por ano: varridos, o atual e os que ainda faltam. */
function renderTape(bf: BackfillState, monthly: Map<string, MonthlyResults>): void {
  const done = new Set(bf.donePeriods);
  const all = new Set<string>([...bf.donePeriods, ...bf.periods]);
  if (bf.cursor) all.add(bf.cursor);
  // Meses com partida gravada entram mesmo que a varredura nao os tenha listado.
  for (const key of monthly.keys()) all.add(key);
  const months = [...all].sort();

  const tape = $('tape');
  const legend = $('tape-legend');

  if (months.length === 0) {
    tape.textContent = '';
    delete tape.dataset.signature;
    setText(legend, 'A varredura ainda não começou.');
    return;
  }

  // Reconstroi so quando a composicao muda; senao a animacao do mes atual reinicia a cada tick.
  const stateOf = (m: string) => (m === bf.cursor ? 'current' : done.has(m) ? 'done' : 'todo');
  const signature = months.map((m) => `${m}:${stateOf(m)[0]}`).join('|');
  if (tape.dataset.signature !== signature) {
    tape.dataset.signature = signature;
    tape.textContent = '';
    const byYear = new Map<string, string[]>();
    for (const m of months) {
      const year = m.slice(0, 4);
      byYear.set(year, [...(byYear.get(year) ?? []), m]);
    }
    for (const [year, list] of byYear) {
      const group = document.createElement('div');
      group.className = 'tape-year';
      const label = document.createElement('b');
      label.textContent = year;
      const cells = document.createElement('div');
      cells.className = 'tape-cells';
      for (const m of list) {
        const cell = document.createElement('span');
        cell.className = `cell ${stateOf(m)}`;
        cell.tabIndex = 0;
        cell.dataset.month = m;
        cell.setAttribute('role', 'img');
        cells.append(cell);
      }
      group.append(label, cells);
      tape.append(group);
    }
  }

  // O tooltip muda a cada tick (partidas novas no mes), sem reconstruir as celulas.
  for (const cell of tape.querySelectorAll<HTMLElement>('.cell')) {
    const m = cell.dataset.month ?? '';
    const state = stateOf(m);
    const what = state === 'current' ? 'lendo agora' : state === 'done' ? 'lido' : 'na fila';
    const tip = `${fmtPeriodLong(m)}: ${what}. ${monthSummary(monthly.get(m))}`;
    if (cell.dataset.tip !== tip) {
      cell.dataset.tip = tip;
      cell.setAttribute('aria-label', tip);
    }
  }

  const doneCount = months.filter((m) => done.has(m)).length;
  const todoCount = months.length - doneCount - (bf.cursor && !done.has(bf.cursor) ? 1 : 0);
  legend.textContent = '';
  const b1 = document.createElement('b');
  b1.textContent = `${doneCount} ${doneCount === 1 ? 'mês lido' : 'meses lidos'}`;
  legend.append(b1);
  if (bf.cursor && bf.status === 'running') legend.append(`, lendo ${fmtPeriod(bf.cursor)}`);
  if (todoCount > 0) {
    legend.append(', ');
    const b2 = document.createElement('b');
    b2.textContent = `${todoCount} na fila`;
    legend.append(b2);
  }
  legend.append('.');
}

function renderAlert(failure: { url: string; at: number; reason: string; stage: string } | null): void {
  const alert = $('alert');
  if (!failure) {
    alert.hidden = true;
    return;
  }
  alert.hidden = false;
  alert.textContent = '';
  const body = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = `A coleta falhou em ${fmtDate(failure.at)}. Provavelmente a GC mudou o layout.`;
  const meta = document.createElement('div');
  meta.className = 'alert-meta';
  meta.textContent = `Etapa ${failure.stage}: ${failure.reason}`;
  const url = document.createElement('div');
  url.className = 'alert-meta';
  url.textContent = failure.url;
  body.append(title, meta, url);
  alert.append(body);
}

/**
 * So reconstroi a lista quando os dados mudaram: o tick de 2 s nao pode fechar a
 * gaveta que o usuario acabou de abrir. Quando reconstroi, reabre o que estava aberto.
 */
function renderList(
  target: HTMLElement,
  items: Encounter[],
  opts: { ranked?: boolean; emptyTitle?: string; emptyHint?: string } = {},
): void {
  const signature = JSON.stringify([
    opts.ranked ?? false,
    items.map((e) => [
      e.gcId, e.nick, e.lastLevel, e.total, e.together, e.against,
      e.togetherWins, e.togetherLosses, e.againstWins, e.againstLosses,
      e.kills, e.deaths, e.kdRows, e.lastPlayedAt, e.note ?? '',
    ]),
  ]);
  if (target.dataset.signature === signature) return;
  target.dataset.signature = signature;

  const wasOpen = new Set(
    [...target.querySelectorAll<HTMLElement>('.player .head[aria-expanded="true"]')].map(
      (h) => h.closest<HTMLElement>('.player')?.dataset.gcId ?? '',
    ),
  );

  target.textContent = '';
  if (items.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    const strong = document.createElement('strong');
    strong.textContent = opts.emptyTitle ?? 'Nenhum reencontro ainda';
    li.append(
      strong,
      opts.emptyHint ?? 'Jogue uma partida com a GC aberta ou inicie a varredura do histórico.',
    );
    target.append(li);
    return;
  }
  items.forEach((e, i) => {
    const row = playerRow(e, opts.ranked ? i + 1 : null);
    target.append(row);
    if (wasOpen.has(String(e.gcId))) row.querySelector<HTMLButtonElement>('.head')?.click();
  });
}

/** Quantas partidas a gaveta mostra antes do "ver todas". */
const DRAWER_PAGE = 10;

/**
 * Pill de aproveitamento MEU num recorte (junto ou contra).
 * `played` e o total de partidas do recorte; `wins+losses+draws` so as com placar.
 */
function ratePill(wins: number, losses: number, draws: number, played: number, label: 'junto' | 'contra'): HTMLElement {
  const pill = document.createElement('span');
  const decided = wins + losses + draws;
  if (played === 0) {
    pill.className = 'rate';
    pill.textContent = label === 'junto' ? 'nunca junto' : 'nunca contra';
    return pill;
  }
  if (decided === 0) {
    pill.className = 'rate';
    pill.textContent = 'sem placar';
    pill.title = `${fmtInt(played)} ${played === 1 ? 'partida' : 'partidas'} ${label}, nenhuma com placar legível`;
    return pill;
  }
  const pct = Math.round((wins / decided) * 100);
  pill.className = pct >= 50 ? 'rate good' : 'rate bad';
  pill.textContent = `${pct}% V`;
  pill.title =
    `${label === 'junto' ? 'No mesmo time' : 'Em times opostos'}: ${fmtInt(wins)}V ${fmtInt(losses)}D` +
    `${draws ? ` ${fmtInt(draws)}E` : ''} em ${fmtInt(played)} ${played === 1 ? 'partida' : 'partidas'}`;
  return pill;
}

/** Linha "Junto: 71% V (5V 2D em 7)" para a gaveta. */
function splitStat(label: 'junto' | 'contra', wins: number, losses: number, draws: number, played: number): HTMLElement {
  const box = document.createElement('span');
  box.className = 'split';
  const name = document.createElement('span');
  name.className = 'split-label';
  name.textContent = label === 'junto' ? 'Junto' : 'Contra';
  box.append(name, ratePill(wins, losses, draws, played, label));
  if (played > 0) {
    const detail = document.createElement('span');
    detail.className = 'split-detail';
    detail.textContent = `${fmtInt(wins)}V ${fmtInt(losses)}D${draws ? ` ${fmtInt(draws)}E` : ''} em ${fmtInt(played)}`;
    box.append(detail);
  }
  return box;
}

/** Linha de jogador que abre, ao clique, a lista de partidas em comum. */
function playerRow(e: Encounter, rank: number | null): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'player';
  li.dataset.gcId = String(e.gcId);

  const head = document.createElement('button');
  head.type = 'button';
  head.className = rank === null ? 'head no-rank' : 'head';
  head.setAttribute('aria-expanded', 'false');

  if (rank !== null) {
    const rk = document.createElement('span');
    rk.className = 'rank';
    rk.textContent = String(rank);
    head.append(rk);
  }

  const who = document.createElement('span');
  who.className = 'who';
  const nameRow = document.createElement('span');
  nameRow.className = 'name-row';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = e.nick;
  nameRow.append(name);
  if (e.lastLevel !== null) nameRow.append(levelBadge(e.lastLevel));
  const sub = document.createElement('span');
  sub.className = 'sub';
  const id = document.createElement('span');
  id.textContent = `#${e.gcId}`;
  sub.append(id);
  if (e.lastPlayedAt) {
    const last = document.createElement('span');
    last.textContent = `último ${fmtDay(e.lastPlayedAt)}`;
    sub.append(last);
  }
  // K/D nas partidas em comum. Coluna propria no desktop; no celular entra na sublinha.
  const kd = document.createElement('span');
  kd.className = 'kd';
  if (e.kdRows > 0) {
    const tone = kdTone(e.kills, e.deaths);
    kd.classList.add(tone);
    const value = document.createElement('b');
    value.textContent = kdText(e.kills, e.deaths);
    kd.append(value, 'K/D');
    kd.title =
      `${fmtInt(e.kills)} kills, ${fmtInt(e.deaths)} deaths em ${fmtInt(e.kdRows)} ` +
      `${e.kdRows === 1 ? 'partida' : 'partidas'} com o dado`;
    const subKd = document.createElement('span');
    subKd.className = `sub-kd ${tone}`;
    subKd.textContent = `K/D ${kdText(e.kills, e.deaths)}`;
    sub.append(subKd);
  }
  who.append(nameRow, sub);

  const counts = document.createElement('span');
  counts.className = 'counts';
  const total = document.createElement('b');
  total.textContent = `${e.total}x`;
  const split = document.createElement('span');
  split.textContent = `${e.against} contra, ${e.together} junto`;
  counts.append(total, split);

  // No card, so o aproveitamento JUNTO: mesma partida, mesmo time.
  const rate = ratePill(e.togetherWins, e.togetherLosses, e.togetherDraws, e.together, 'junto');

  const chev = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  chev.setAttribute('viewBox', '0 0 24 24');
  chev.setAttribute('width', '16');
  chev.setAttribute('height', '16');
  chev.setAttribute('aria-hidden', 'true');
  chev.classList.add('chev');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'm6 9 6 6 6-6');
  chev.append(path);

  head.append(avatar(e.gcId, e.nick), who, counts, kd, rate, chev);
  // Botao fora do `head`: botao dentro de botao nao e HTML valido.
  const top = document.createElement('div');
  top.className = 'player-top';
  top.append(head, mapsButton(e.gcId, e.nick, e.lastLevel));
  li.append(top);

  if (e.note) {
    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = `anotação: ${e.note}`;
    li.append(note);
  }

  const drawer = document.createElement('div');
  drawer.className = 'drawer';
  const inner = document.createElement('div');
  drawer.append(inner);
  li.append(drawer);

  let loaded = false;
  head.addEventListener('click', () => {
    const open = drawer.classList.toggle('open');
    head.setAttribute('aria-expanded', String(open));
    if (!open || loaded) return;
    loaded = true;
    const drawerHead = document.createElement('div');
    drawerHead.className = 'drawer-head';
    drawerHead.append(
      splitStat('junto', e.togetherWins, e.togetherLosses, e.togetherDraws, e.together),
      splitStat('contra', e.againstWins, e.againstLosses, e.againstDraws, e.against),
      profileLink(e.gcId),
    );
    inner.append(drawerHead, matchesList(e));
  });

  return li;
}

/**
 * Lista de partidas em comum: as 10 mais recentes primeiro; "ver todas" busca o resto.
 * `e.total` ja diz quantas existem, entao o botao so aparece quando ha mais.
 */
function matchesList(e: Encounter): HTMLUListElement {
  const list = document.createElement('ul');
  list.className = 'matches';
  const loading = document.createElement('li');
  loading.className = 'placeholder';
  loading.textContent = 'carregando partidas…';
  list.append(loading);

  const fill = (matches: SharedMatch[]) => {
    list.textContent = '';
    if (matches.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'placeholder';
      empty.textContent = 'Sem detalhe gravado para este jogador.';
      list.append(empty);
      return;
    }
    for (const m of matches) list.append(matchRow(m));
  };

  void getSharedMatches(e.gcId, DRAWER_PAGE).then((matches) => {
    fill(matches);
    const remaining = e.total - matches.length;
    if (remaining <= 0 || matches.length < DRAWER_PAGE) return;

    const more = document.createElement('li');
    more.className = 'more';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-sm';
    btn.textContent = `Ver todas as ${fmtInt(e.total)} partidas`;
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      void busy(btn, () => getSharedMatches(e.gcId, Math.max(e.total, DRAWER_PAGE) + 50)).then((all) => {
        fill(all);
      });
    });
    more.append(btn);
    list.append(more);
  });

  return list;
}

function matchRow(m: SharedMatch): HTMLLIElement {
  const li = document.createElement('li');

  const res = document.createElement('span');
  res.className = m.result === 'win' ? 'res w' : m.result === 'loss' ? 'res l' : 'res';
  res.textContent = m.result === 'win' ? 'V' : m.result === 'loss' ? 'D' : m.result === 'draw' ? 'E' : '?';
  res.title =
    m.result === 'win' ? 'vitória' : m.result === 'loss' ? 'derrota' : m.result === 'draw' ? 'empate' : 'placar não registrado';

  const when = document.createElement('span');
  when.textContent = new Date(m.playedAt).toLocaleDateString('pt-BR');

  const rel = document.createElement('span');
  rel.className = m.relation === 'together' ? 'rel together' : 'rel';
  rel.textContent = m.relation === 'together' ? 'junto' : 'contra';

  const map = document.createElement('span');
  map.className = 'map';
  const mapName = document.createElement('span');
  mapName.textContent = m.map ?? 'mapa desconhecido';
  map.append(mapName);
  if (m.levelAtMatch !== null) map.append(levelBadge(m.levelAtMatch, true));

  const score = document.createElement('span');
  score.className = 'score';
  score.textContent = m.score ?? '';

  const link = document.createElement('a');
  link.href = `https://gamersclub.com.br/lobby/match/${m.matchId}`;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = 'abrir na GC';
  link.addEventListener('click', (ev) => ev.stopPropagation());

  li.append(res, when, rel, map, score, link);
  return li;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function say(text: string, kind: 'ok' | 'error' = 'ok'): void {
  const toast = $('toast');
  toast.textContent = text;
  toast.classList.toggle('is-error', kind === 'error');
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3800);
}

/** Marca o botao como ocupado ate a promessa resolver. */
async function busy<T>(button: HTMLElement, work: () => Promise<T>): Promise<T> {
  button.classList.add('is-busy');
  try {
    return await work();
  } finally {
    button.classList.remove('is-busy');
  }
}

async function control(action: 'start' | 'pause' | 'restart'): Promise<void> {
  // Iniciar/pausar vao por MENSAGEM, nao por escrita no banco: o worker nao observa
  // o IndexedDB, entao escrever aqui so surtia efeito no proximo alarme (1 min).
  if (action === 'start' || action === 'pause') {
    await send({ type: 'backfill:control', action });
    await refresh();
    return;
  }

  const next: BackfillState = {
    status: 'idle',
    cursor: null,
    queue: [],
    periods: [],
    oldestPeriod: null,
    // Recomecar do zero esquece tudo, inclusive os meses ja varridos.
    donePeriods: [],
    emptyMonths: 0,
    lastPage: null,
    pagesDone: 0,
    matchesDone: 0,
    consecutiveFailures: 0,
    startedAt: null,
    updatedAt: Date.now(),
    failed: [],
  };
  await updateMeta({ backfill: next });
  await refresh();
}

function download(dump: DbDump): void {
  const blob = new Blob([JSON.stringify(dump)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `gc-encounters-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// Mapas: grafico de barras + tabela. Servem o modal de cada jogador e o agregador.
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** "de_mirage" -> "Mirage", "de_dust2" -> "Dust2". */
function mapLabel(map: string | null): string {
  if (!map) return 'desconhecido';
  const bare = map.replace(/^(de|cs|ar|dz|gd)_/i, '').replace(/_/g, ' ').trim();
  return bare ? bare.replace(/\b\w/g, (c) => c.toUpperCase()) : map;
}

/** "5V 3D 1E", com "2 sem placar" quando houver. */
function recordText(s: { played: number; wins: number; losses: number; draws: number }): string {
  const parts = [`${fmtInt(s.wins)}V`, `${fmtInt(s.losses)}D`];
  if (s.draws) parts.push(`${fmtInt(s.draws)}E`);
  const unknown = s.played - s.wins - s.losses - s.draws;
  if (unknown > 0) parts.push(`${fmtInt(unknown)} sem placar`);
  return parts.join(' ');
}

/** Pill de aproveitamento: % de vitorias sobre as partidas com placar. */
function winPill(s: { played: number; wins: number; losses: number; draws: number }): HTMLElement {
  const decided = s.wins + s.losses + s.draws;
  if (decided === 0) {
    const pill = el('span', 'rate', s.played ? 'sem placar' : '—');
    return pill;
  }
  const pct = Math.round((s.wins / decided) * 100);
  const pill = el('span', pct >= 50 ? 'rate good' : 'rate bad', `${pct}% V`);
  pill.title = recordText(s);
  return pill;
}

function kdCell(kills: number, deaths: number, kdRows: number): HTMLElement {
  if (kdRows === 0) {
    const none = el('span', 'muted', 'sem dado');
    none.title = 'K/D só vem das partidas coletadas depois que o campo passou a existir.';
    return none;
  }
  const b = el('b', `kd-val ${kdTone(kills, deaths)}`, kdText(kills, deaths));
  b.title = `${fmtInt(kills)} kills, ${fmtInt(deaths)} deaths em ${fmtInt(kdRows)} ${kdRows === 1 ? 'partida' : 'partidas'} com o dado`;
  return b;
}

const MAP_CHART_ROWS = 8;

/**
 * Barras horizontais, uma por mapa, comprimento = partidas jogadas. Cada barra e
 * dividida em vitorias / derrotas / resto, sempre nessa ordem. Verde e vermelho se
 * confundem para quem tem deuteranopia (validador: dE 4,4), entao a derrota leva
 * hachura e o percentual vem escrito ao lado: a cor nunca e a unica pista.
 */
function mapChart(maps: MapStat[], limit = MAP_CHART_ROWS): HTMLElement {
  const box = el('figure', 'mapchart');
  const legend = el('figcaption', 'mc-legend');
  for (const [cls, label] of [['w', 'Vitórias'], ['l', 'Derrotas'], ['o', 'Empates e sem placar']] as const) {
    const item = el('span', 'mc-key');
    item.append(el('i', `sw ${cls}`), label);
    legend.append(item);
  }
  box.append(legend);

  const shown = maps.slice(0, limit);
  const max = Math.max(1, ...shown.map((s) => s.played));
  const rows = el('div', 'mc-rows');
  rows.setAttribute('role', 'list');
  for (const s of shown) {
    const row = el('div', 'mc-row');
    row.setAttribute('role', 'listitem');
    row.tabIndex = 0;
    const decided = s.wins + s.losses + s.draws;
    const rate = decided ? `${Math.round((s.wins / decided) * 100)}% de vitórias` : 'sem placar';
    const kd = s.kdRows ? `, K/D ${kdText(s.kills, s.deaths)}` : '';
    const tip = `${mapLabel(s.map)}: ${fmtInt(s.played)} ${s.played === 1 ? 'partida' : 'partidas'}, ${recordText(s)}, ${rate}${kd}`;
    row.dataset.tip = tip;
    row.setAttribute('aria-label', tip);

    const name = el('span', 'mc-name', mapLabel(s.map));
    const track = el('span', 'mc-track');
    const bar = el('span', 'mc-bar');
    bar.style.width = `${(s.played / max) * 100}%`;
    const other = s.played - s.wins - s.losses;
    for (const [cls, n] of [['w', s.wins], ['l', s.losses], ['o', other]] as const) {
      if (n <= 0) continue;
      const seg = el('i', cls);
      seg.style.flexGrow = String(n);
      bar.append(seg);
    }
    track.append(bar);

    const val = el('span', 'mc-val');
    val.append(el('b', '', fmtInt(s.played)), el('span', '', decided ? `${Math.round((s.wins / decided) * 100)}% V` : '—'));
    row.append(name, track, val);
    rows.append(row);
  }
  box.append(rows);

  if (maps.length > limit) {
    const rest = maps.length - limit;
    box.append(el('p', 'mc-more', `e mais ${fmtInt(rest)} ${rest === 1 ? 'mapa' : 'mapas'} na tabela abaixo`));
  }
  return box;
}

/** A mesma informacao do grafico, em tabela: e a leitura exata e a acessivel. */
function mapTable(maps: MapStat[]): HTMLElement {
  const wrap = el('div', 'table-wrap');
  const table = el('table', 'dtable');
  const head = el('tr');
  for (const [label, num] of [
    ['Mapa', false],
    ['Partidas', true],
    ['V', true],
    ['D', true],
    ['E', true],
    ['Aproveitamento', true],
    ['K/D', true],
  ] as const) {
    const th = el('th', num ? 'num' : '', label);
    th.scope = 'col';
    head.append(th);
  }
  table.append(el('thead'), el('tbody'));
  table.tHead!.append(head);
  for (const s of maps) {
    const tr = el('tr');
    const name = el('th', 'map-name', mapLabel(s.map));
    name.scope = 'row';
    if (s.map) name.title = s.map;
    const rate = el('td', 'num');
    rate.append(winPill(s));
    const kd = el('td', 'num');
    kd.append(kdCell(s.kills, s.deaths, s.kdRows));
    tr.append(
      name,
      el('td', 'num', fmtInt(s.played)),
      el('td', 'num good', fmtInt(s.wins)),
      el('td', 'num bad', fmtInt(s.losses)),
      el('td', 'num', fmtInt(s.draws)),
      rate,
      kd,
    );
    table.tBodies[0]!.append(tr);
  }
  wrap.append(table);
  return wrap;
}

/** Melhor e pior mapa so contam com pelo menos 3 partidas com placar: 1 de 1 nao e 100%. */
const MIN_FOR_BEST = 3;

function bestAndWorst(maps: MapStat[]): { best: MapStat | null; worst: MapStat | null } {
  const rate = (s: MapStat) => s.wins / (s.wins + s.losses + s.draws);
  const eligible = maps.filter((s) => s.map !== null && s.wins + s.losses + s.draws >= MIN_FOR_BEST);
  if (eligible.length === 0) return { best: null, worst: null };
  const sorted = [...eligible].sort((a, b) => rate(b) - rate(a) || b.played - a.played);
  const best = sorted[0] ?? null;
  const worst = sorted.length > 1 ? (sorted[sorted.length - 1] ?? null) : null;
  return { best, worst };
}

function mapSummary(maps: MapStat[]): HTMLElement {
  const total = maps.reduce((n, s) => n + s.played, 0);
  const top = maps.find((s) => s.map !== null) ?? null;
  const { best, worst } = bestAndWorst(maps);
  const dl = el('dl', 'mstats');
  const cell = (label: string, value: string, sub?: string, tone?: 'good' | 'bad') => {
    const div = el('div');
    const dd = el('dd', tone ? `is-${tone}` : '', value);
    div.append(el('dt', '', label), dd);
    if (sub) div.append(el('span', 'mstats-sub', sub));
    dl.append(div);
  };
  const rateOf = (s: MapStat) => `${Math.round((s.wins / (s.wins + s.losses + s.draws)) * 100)}% V em ${fmtInt(s.played)}`;
  cell('Partidas', fmtInt(total));
  cell('Mapas diferentes', fmtInt(maps.filter((s) => s.map !== null).length));
  cell('Mais jogado', top ? mapLabel(top.map) : '—', top ? `${fmtInt(top.played)} partidas` : undefined);
  cell('Melhor mapa', best ? mapLabel(best.map) : '—', best ? rateOf(best) : `mín. ${MIN_FOR_BEST} partidas`, best ? 'good' : undefined);
  cell('Pior mapa', worst ? mapLabel(worst.map) : '—', worst ? rateOf(worst) : undefined, worst ? 'bad' : undefined);
  return dl;
}

function mapsButton(gcId: number, nick: string, level: number | null): HTMLButtonElement {
  const btn = el('button', 'map-btn');
  btn.type = 'button';
  btn.title = `Mapas de ${nick}`;
  btn.setAttribute('aria-label', `Mapas de ${nick}`);
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M9 4 3.5 6v14L9 18l6 2 5.5-2V4L15 6 9 4Z" /><path d="M9 4v14M15 6v14" /></svg>';
  btn.append(el('span', '', 'Mapas'));
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    void openMapsModal(gcId, nick, level);
  });
  return btn;
}

/** Descarta resposta atrasada quando o usuario abre outro jogador antes da primeira voltar. */
let mapsToken = 0;

async function openMapsModal(gcId: number, nick: string, level: number | null): Promise<void> {
  const token = ++mapsToken;
  const dlg = $('maps-modal') as HTMLDialogElement;
  avatar(gcId, nick, $('maps-avatar'));
  $('maps-title').textContent = `Mapas de ${nick}`;
  const lvl = $('maps-level');
  lvl.textContent = '';
  if (level !== null) lvl.append(levelBadge(level));
  const sub = $('maps-sub');
  sub.textContent = `#${gcId}`;
  const body = $('maps-body');
  body.textContent = '';
  body.append(el('p', 'placeholder', 'carregando mapas…'));
  if (!dlg.open) dlg.showModal();

  const [maps, meta] = await Promise.all([getPlayerMapStats(gcId), getMeta()]);
  if (token !== mapsToken) return;

  sub.textContent =
    gcId === meta.myGcId
      ? 'Todas as suas partidas gravadas.'
      : 'Nas partidas gravadas em que vocês se cruzaram, com o resultado do jogador em cada uma.';
  body.textContent = '';
  if (maps.length === 0) {
    const empty = el('div', 'empty-state');
    empty.append(el('strong', '', 'Nenhuma partida gravada'), 'Os mapas aparecem quando houver partida registrada.');
    body.append(empty);
    return;
  }
  body.append(
    mapSummary(maps),
    el('h3', 'sub-head', 'Mais jogados'),
    mapChart(maps),
    el('h3', 'sub-head', 'Por mapa'),
    mapTable(maps),
  );
}

function wireMapsModal(): void {
  const dlg = $('maps-modal') as HTMLDialogElement;
  $('maps-close').addEventListener('click', () => dlg.close());
  // Clique no fundo escurecido fecha; clique dentro do cartao nao.
  dlg.addEventListener('click', (ev) => {
    if (ev.target === dlg) dlg.close();
  });
}

// ---------------------------------------------------------------------------
// Agregador: ate 4 jogadores, todas as partidas gravadas com eles em campo.
// ---------------------------------------------------------------------------

interface GroupPick {
  gcId: number;
  nick: string;
  lastLevel: number | null;
}

/** Escolha lembrada entre visitas. Conveniencia: sem storage a pagina funciona igual. */
const GROUP_STORAGE = 'gc-encounters:group';

function loadGroup(): { picks: GroupPick[]; mode: GroupMode } {
  try {
    const raw = JSON.parse(localStorage.getItem(GROUP_STORAGE) ?? 'null') as {
      picks?: GroupPick[];
      mode?: GroupMode;
    } | null;
    const picks = Array.isArray(raw?.picks)
      ? raw.picks.filter((p) => Number.isInteger(p?.gcId) && typeof p.nick === 'string').slice(0, MAX_GROUP)
      : [];
    return { picks, mode: raw?.mode === 'match' ? 'match' : 'team' };
  } catch {
    return { picks: [], mode: 'team' };
  }
}

function saveGroup(): void {
  try {
    localStorage.setItem(GROUP_STORAGE, JSON.stringify({ picks: groupPicks, mode: groupMode }));
  } catch {
    // Sem storage (janela privada, dados bloqueados): so nao lembra na proxima visita.
  }
}

const initialGroup = loadGroup();
let groupPicks: GroupPick[] = initialGroup.picks;
let groupMode: GroupMode = initialGroup.mode;
let groupToken = 0;

/** Partidas da lista do agregador antes do "ver mais". */
const GROUP_PAGE = 20;
const SUGGEST_LIMIT = 8;

function addToGroup(p: GroupPick): void {
  if (groupPicks.length >= MAX_GROUP) {
    say(`O agregador junta no máximo ${MAX_GROUP} jogadores`, 'error');
    return;
  }
  if (groupPicks.some((g) => g.gcId === p.gcId)) return;
  groupPicks = [...groupPicks, p];
  saveGroup();
  renderChips();
  void renderGroup();
}

function removeFromGroup(gcId: number): void {
  groupPicks = groupPicks.filter((g) => g.gcId !== gcId);
  saveGroup();
  renderChips();
  void renderGroup();
}

function renderChips(): void {
  const box = $('group-chips');
  box.textContent = '';
  if (groupPicks.length === 0) {
    box.append(el('span', 'chips-empty', 'Nenhum jogador escolhido. Busque abaixo ou inclua você mesmo.'));
  }
  for (const p of groupPicks) {
    const chip = el('span', 'chip');
    const name = el('span', 'chip-name', p.nick);
    chip.append(avatar(p.gcId, p.nick, el('span', 'avatar avatar-xs')), name);
    if (p.lastLevel !== null) chip.append(levelBadge(p.lastLevel, true));
    const rm = el('button', 'chip-x');
    rm.type = 'button';
    rm.setAttribute('aria-label', `Remover ${p.nick}`);
    rm.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>';
    rm.addEventListener('click', () => removeFromGroup(p.gcId));
    chip.append(rm);
    box.append(chip);
  }
  const count = el('span', 'chips-count', `${groupPicks.length} de ${MAX_GROUP}`);
  box.append(count);

  const input = $('group-search') as HTMLInputElement;
  const full = groupPicks.length >= MAX_GROUP;
  input.disabled = full;
  input.placeholder = full ? `Limite de ${MAX_GROUP} jogadores atingido` : 'Adicionar jogador por nick ou id';
  ($('group-clear') as HTMLButtonElement).disabled = groupPicks.length === 0;

  for (const b of document.querySelectorAll<HTMLButtonElement>('.seg [data-mode]')) {
    b.setAttribute('aria-checked', String(b.dataset.mode === groupMode));
  }
}

/** Sugestoes do campo: busca com texto, ranking de reencontros sem texto. */
let suggestItems: Encounter[] = [];
let suggestActive = -1;
let suggestQuery = '';

async function openSuggest(q: string): Promise<void> {
  suggestQuery = q;
  const rows = q ? await searchPlayers(q) : await getTopEncounters(SUGGEST_LIMIT * 2);
  if (suggestQuery !== q) return; // resposta atrasada
  const chosen = new Set(groupPicks.map((g) => g.gcId));
  suggestItems = rows.filter((r) => !chosen.has(r.gcId)).slice(0, SUGGEST_LIMIT);
  suggestActive = suggestItems.length ? 0 : -1;
  paintSuggest(q);
}

function paintSuggest(q: string): void {
  const list = $('group-suggest');
  const input = $('group-search') as HTMLInputElement;
  list.textContent = '';
  if (suggestItems.length === 0) {
    list.append(el('li', 'suggest-empty', q ? `Ninguém com "${q}" no seu histórico` : 'Nenhum jogador gravado ainda'));
  }
  suggestItems.forEach((e, i) => {
    const li = el('li', i === suggestActive ? 'is-active' : '');
    li.id = `group-opt-${e.gcId}`;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(i === suggestActive));
    const who = el('span', 'suggest-who');
    const row = el('span', 'name-row');
    row.append(el('span', 'suggest-name', e.nick));
    if (e.lastLevel !== null) row.append(levelBadge(e.lastLevel, true));
    who.append(row, el('span', 'suggest-sub', `#${e.gcId} · ${fmtInt(e.total)} ${e.total === 1 ? 'partida' : 'partidas'}`));
    li.append(avatar(e.gcId, e.nick, el('span', 'avatar avatar-sm')), who);
    // mousedown, nao click: o blur do input fecharia a lista antes do click chegar.
    li.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      pickSuggestion(i);
    });
    list.append(li);
  });
  list.hidden = false;
  input.setAttribute('aria-expanded', 'true');
  const active = suggestItems[suggestActive];
  if (active) input.setAttribute('aria-activedescendant', `group-opt-${active.gcId}`);
  else input.removeAttribute('aria-activedescendant');
}

function closeSuggest(): void {
  $('group-suggest').hidden = true;
  const input = $('group-search') as HTMLInputElement;
  input.setAttribute('aria-expanded', 'false');
  input.removeAttribute('aria-activedescendant');
  suggestActive = -1;
}

function pickSuggestion(i: number): void {
  const e = suggestItems[i];
  if (!e) return;
  addToGroup({ gcId: e.gcId, nick: e.nick, lastLevel: e.lastLevel });
  const input = $('group-search') as HTMLInputElement;
  input.value = '';
  if (groupPicks.length >= MAX_GROUP) {
    closeSuggest();
    return;
  }
  void openSuggest('');
}

function groupNames(): string {
  const nicks = groupPicks.map((p) => p.nick);
  if (nicks.length <= 1) return nicks[0] ?? '';
  return `${nicks.slice(0, -1).join(', ')} e ${nicks[nicks.length - 1]}`;
}

async function renderGroup(): Promise<void> {
  const token = ++groupToken;
  const box = $('group-result');
  if (groupPicks.length === 0) {
    box.textContent = '';
    return;
  }
  box.classList.add('is-loading');
  const stats = await getGroupStats(
    groupPicks.map((p) => p.gcId),
    groupMode,
  );
  if (token !== groupToken) return;
  box.classList.remove('is-loading');
  box.textContent = '';

  // Nick e nivel atualizados pelo banco (o storage pode ter nick antigo).
  let changed = false;
  groupPicks = groupPicks.map((p) => {
    const fresh = stats.players.find((s) => s.gcId === p.gcId);
    if (!fresh || (fresh.nick === p.nick && fresh.lastLevel === p.lastLevel)) return p;
    changed = true;
    return { ...p, nick: fresh.nick, lastLevel: fresh.lastLevel };
  });
  if (changed) {
    saveGroup();
    renderChips();
  }

  if (stats.matches.length === 0) {
    const empty = el('div', 'panel empty-state');
    const title =
      groupPicks.length === 1
        ? `Nenhuma partida gravada com ${groupNames()}`
        : `Nenhuma partida gravada com ${groupNames()} ${groupMode === 'team' ? 'no mesmo time' : 'na mesma partida'}`;
    empty.append(
      el('strong', '', title),
      groupMode === 'team' && groupPicks.length > 1
        ? 'Tente "Na mesma partida" para incluir as vezes em que jogaram em lados opostos.'
        : 'Só entram partidas que a extensão registrou.',
    );
    box.append(empty);
    return;
  }

  box.append(groupSummary(stats), el('h3', 'sub-head', 'Jogadores'), groupPlayersTable(stats));

  const mapsHead = el('h3', 'sub-head', 'Mapas');
  box.append(mapsHead, mapChart(stats.maps), mapTable(stats.maps));

  box.append(el('h3', 'sub-head', `Partidas (${fmtInt(stats.matches.length)})`), groupMatchList(stats));
}

function groupSummary(stats: GroupStats): HTMLElement {
  const wrap = el('div', 'group-summary');
  const dl = el('dl', 'stats');
  const cell = (label: string, value: string, cls = '', title = '') => {
    const div = el('div');
    const dd = el('dd', cls, value);
    if (title) dd.title = title;
    div.append(el('dt', '', label), dd);
    dl.append(div);
  };
  const decided = stats.wins + stats.losses + stats.draws;
  const kills = stats.players.reduce((n, p) => n + p.kills, 0);
  const deaths = stats.players.reduce((n, p) => n + p.deaths, 0);
  const kdRows = stats.players.reduce((n, p) => n + p.kdRows, 0);
  const top = stats.maps.find((s) => s.map !== null);

  cell('Partidas', fmtInt(stats.matches.length));
  cell('Vitórias', fmtInt(stats.wins), 'is-good');
  cell('Derrotas', fmtInt(stats.losses), 'is-bad', stats.draws ? `${fmtInt(stats.draws)} empates` : '');
  cell('Aproveitamento', decided ? `${Math.round((stats.wins / decided) * 100)}%` : 'sem placar');
  cell(
    'K/D do grupo',
    kdRows ? kdText(kills, deaths) : 'sem dado',
    kdRows ? `is-${kdTone(kills, deaths)}` : 'is-date',
    kdRows ? `${fmtInt(kills)} kills, ${fmtInt(deaths)} deaths somados` : '',
  );
  cell('Mapa mais jogado', top ? mapLabel(top.map) : '—', 'is-date', top ? `${fmtInt(top.played)} partidas` : '');
  wrap.append(dl);

  if (stats.mode === 'match' && groupPicks.length > 1) {
    const other = stats.matches.length - stats.sameTeam;
    wrap.append(
      el(
        'p',
        'group-note',
        `Vitórias e derrotas do grupo contam só as ${fmtInt(stats.sameTeam)} partidas com todos no mesmo time. ` +
          `Nas outras ${fmtInt(other)} cada um tem o próprio resultado, na tabela abaixo.`,
      ),
    );
  }
  return wrap;
}

function groupPlayersTable(stats: GroupStats): HTMLElement {
  const wrap = el('div', 'table-wrap');
  const table = el('table', 'dtable gtable');
  const head = el('tr');
  for (const [label, num] of [
    ['Jogador', false],
    ['Partidas', true],
    ['V', true],
    ['D', true],
    ['%V', true],
    ['K/D', true],
    ['Kills', true],
    ['Deaths', true],
    ['K/partida', true],
    ['', true],
  ] as const) {
    const th = el('th', num ? 'num' : '', label);
    th.scope = 'col';
    head.append(th);
  }
  table.append(el('thead'), el('tbody'));
  table.tHead!.append(head);

  for (const p of stats.players) {
    const tr = el('tr');
    const who = el('th', 'gt-who');
    who.scope = 'row';
    const row = el('span', 'name-row');
    const link = el('a', 'gt-nick', p.nick);
    link.href = profileUrl(p.gcId);
    link.target = '_blank';
    link.rel = 'noopener';
    row.append(avatar(p.gcId, p.nick, el('span', 'avatar avatar-sm')), link);
    if (p.lastLevel !== null) row.append(levelBadge(p.lastLevel, true));
    who.append(row);

    const rate = el('td', 'num');
    rate.append(winPill(p));
    const kd = el('td', 'num');
    kd.append(kdCell(p.kills, p.deaths, p.kdRows));
    const hasKd = p.kdRows > 0;
    const perMatch = hasKd
      ? (p.kills / p.kdRows).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
      : '—';
    const btn = el('td', 'num');
    btn.append(mapsButton(p.gcId, p.nick, p.lastLevel));

    tr.append(
      who,
      el('td', 'num', fmtInt(p.played)),
      el('td', 'num good', fmtInt(p.wins)),
      el('td', 'num bad', fmtInt(p.losses)),
      rate,
      kd,
      el('td', 'num', hasKd ? fmtInt(p.kills) : '—'),
      el('td', 'num', hasKd ? fmtInt(p.deaths) : '—'),
      el('td', 'num', perMatch),
      btn,
    );
    table.tBodies[0]!.append(tr);
  }
  wrap.append(table);
  return wrap;
}

function groupMatchList(stats: GroupStats): HTMLElement {
  const box = el('div', 'gmatches-wrap');
  const list = el('ul', 'gmatches');
  let shown = 0;
  const more = el('div', 'gmatches-more');
  const btn = el('button', 'btn btn-sm');
  btn.type = 'button';
  more.append(btn);

  const page = () => {
    for (const m of stats.matches.slice(shown, shown + GROUP_PAGE)) list.append(groupMatchRow(m, stats));
    shown = Math.min(stats.matches.length, shown + GROUP_PAGE);
    const rest = stats.matches.length - shown;
    more.hidden = rest <= 0;
    btn.textContent = `Ver mais ${fmtInt(Math.min(rest, GROUP_PAGE))} de ${fmtInt(rest)}`;
  };
  btn.addEventListener('click', page);
  page();
  box.append(list, more);
  return box;
}

const RESULT_LETTER = { win: 'V', loss: 'D', draw: 'E' } as const;
const RESULT_WORD = { win: 'vitória', loss: 'derrota', draw: 'empate' } as const;

/** Placar "13-8" com o time do grupo primeiro; com o grupo dividido, fica A-B como a GC grava. */
function groupScore(m: GroupMatch): string {
  if (!m.score) return '';
  const team = m.lines[0]?.team;
  if (!m.sameTeam || team !== 'B') return m.score;
  const [a, b] = m.score.split('-');
  return b !== undefined ? `${b}-${a}` : m.score;
}

function groupMatchRow(m: GroupMatch, stats: GroupStats): HTMLLIElement {
  const li = el('li');
  const res = el('span', m.result === 'win' ? 'res w' : m.result === 'loss' ? 'res l' : 'res');
  if (m.result) {
    res.textContent = RESULT_LETTER[m.result];
    res.title = RESULT_WORD[m.result];
  } else {
    res.textContent = m.sameTeam ? '?' : '±';
    res.title = m.sameTeam ? 'placar não registrado' : 'jogaram em times opostos';
  }

  const when = el('span', 'gm-date', new Date(m.playedAt).toLocaleDateString('pt-BR'));
  const map = el('span', 'gm-map', mapLabel(m.map));
  const score = el('span', 'gm-score', groupScore(m));
  score.title = m.sameTeam ? 'placar do ponto de vista do grupo' : 'placar time A x time B';

  const lines = el('span', 'gm-lines');
  m.lines.forEach((l, i) => {
    const p = stats.players[i];
    const chip = el('span', 'gm-line');
    if (!m.sameTeam) {
      // Lados opostos: cada um mostra o proprio resultado e o time.
      const tag = el('b', l.result === 'win' ? 'good' : l.result === 'loss' ? 'bad' : '', l.result ? RESULT_LETTER[l.result] : '?');
      tag.title = `time ${l.team}${l.result ? `, ${RESULT_WORD[l.result]}` : ''}`;
      chip.append(tag);
    }
    chip.append(el('span', 'gm-nick', p?.nick ?? `#${l.gcId}`));
    if (l.kills !== null && l.deaths !== null) {
      const kd = el('span', `gm-kd ${kdTone(l.kills, l.deaths)}`, `${l.kills}/${l.deaths}`);
      kd.title = `${l.kills} kills, ${l.deaths} deaths`;
      chip.append(kd);
    }
    lines.append(chip);
  });

  const link = el('a', 'gm-link', 'abrir na GC');
  link.href = `https://gamersclub.com.br/lobby/match/${m.matchId}`;
  link.target = '_blank';
  link.rel = 'noopener';

  li.append(res, when, map, score, lines, link);
  return li;
}

function wireGroup(): void {
  const input = $('group-search') as HTMLInputElement;
  let timer: ReturnType<typeof setTimeout> | undefined;

  input.addEventListener('focus', () => void openSuggest(input.value.trim()));
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    timer = setTimeout(() => void openSuggest(q), 150);
  });
  input.addEventListener('blur', () => closeSuggest());
  input.addEventListener('keydown', (ev) => {
    const list = $('group-suggest');
    if (ev.key === 'Escape') {
      closeSuggest();
      return;
    }
    if (list.hidden || suggestItems.length === 0) return;
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      const step = ev.key === 'ArrowDown' ? 1 : -1;
      suggestActive = (suggestActive + step + suggestItems.length) % suggestItems.length;
      paintSuggest(suggestQuery);
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      pickSuggestion(Math.max(0, suggestActive));
    }
  });

  for (const b of document.querySelectorAll<HTMLButtonElement>('.seg [data-mode]')) {
    b.addEventListener('click', () => {
      const mode: GroupMode = b.dataset.mode === 'match' ? 'match' : 'team';
      if (mode === groupMode) return;
      groupMode = mode;
      saveGroup();
      renderChips();
      void renderGroup();
    });
  }

  const me = $('group-me');
  me.addEventListener('click', () => {
    void busy(me, async () => {
      const meta = await getMeta();
      if (!meta.myGcId) {
        say('Defina seu id GC em Visão geral primeiro', 'error');
        return;
      }
      const mine = (await getEncounters([meta.myGcId])).get(meta.myGcId);
      addToGroup({
        gcId: meta.myGcId,
        nick: mine?.nick ?? meta.myNick ?? `#${meta.myGcId}`,
        lastLevel: mine?.lastLevel ?? meta.myLevel ?? null,
      });
    });
  });

  $('group-clear').addEventListener('click', () => {
    groupPicks = [];
    saveGroup();
    renderChips();
    void renderGroup();
  });

  renderChips();
  void renderGroup();
}

function wire(): void {
  const start = $('bf-start');
  const pause = $('bf-pause');
  start.addEventListener('click', () => void busy(start, () => control('start')).then(() => say('Varredura iniciada')));
  pause.addEventListener('click', () => void busy(pause, () => control('pause')).then(() => say('Varredura pausada')));
  const retry = $('bf-retry');
  retry.addEventListener('click', () => {
    void busy(retry, () => send<{ queued: number }>({ type: 'backfill:control', action: 'retryFailed' }))
      .then((res) => {
        const n = res?.queued ?? 0;
        say(n ? `${fmtInt(n)} ${n === 1 ? 'partida' : 'partidas'} de volta na fila` : 'Nada para tentar de novo');
        return refresh();
      })
      .catch((err: unknown) => say(`Não consegui reenfileirar: ${String(err)}`, 'error'));
  });

  $('bf-reset').addEventListener('click', () => {
    const ok = confirm(
      [
        'Recomeçar a varredura do zero?',
        '',
        'Apaga fila, posição e a memória dos meses já lidos. A próxima varredura relê o histórico inteiro.',
        '',
        'As partidas já gravadas NÃO são apagadas (para isso, use "Apagar tudo" em Seus dados).',
      ].join(String.fromCharCode(10)),
    );
    if (ok) void control('restart').then(() => say('Varredura zerada'));
  });

  $('my-id-save').addEventListener('click', () => {
    const value = Number(($('my-id') as HTMLInputElement).value);
    if (!Number.isInteger(value) || value <= 0) {
      say('Id inválido: é o número que aparece na URL do seu perfil', 'error');
      return;
    }
    void updateMeta({ myGcId: value })
      .then(() => say(`Id definido: #${value}`))
      .then(refresh);
  });

  const detect = $('my-id-detect');
  detect.addEventListener('click', () => {
    void busy(detect, () =>
      send<{ gcId: number | null; nick: string | null; level: number | null }>({ type: 'detectMyId' }),
    )
      .then((res) => {
        if (res?.gcId) say(`Id detectado: #${res.gcId}${res.nick ? ` (${res.nick})` : ''}`);
        else say('Não consegui detectar. Entre na GC e tente de novo', 'error');
        return refresh();
      })
      .catch(() => say('Não consegui detectar. Entre na GC e tente de novo', 'error'));
  });

  $('throttle-save').addEventListener('click', () => {
    const value = Number(($('throttle') as HTMLInputElement).value);
    const applied = Math.max(MIN_THROTTLE_MS, Number.isFinite(value) ? value : MIN_THROTTLE_MS);
    void updateMeta({ throttleMs: applied })
      .then(() => say(`Intervalo salvo: ${fmtInt(applied)} ms`))
      .then(refresh);
  });

  $('export').addEventListener('click', () => {
    void exportAll().then((dump) => {
      download(dump);
      say(`Exportado: ${fmtInt(dump.matches.length)} partidas`);
    });
  });

  ($('import') as HTMLInputElement).addEventListener('change', (ev) => {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    void file
      .text()
      .then((raw) => importAll(JSON.parse(raw) as DbDump))
      .then((res) => {
        say(`Importado: ${fmtInt(res.matches)} partidas, ${fmtInt(res.players)} jogadores`);
        return refresh();
      })
      .catch((err: unknown) => say(`Importação falhou: ${String(err)}`, 'error'))
      .finally(() => {
        input.value = '';
      });
  });

  const recompute = $('recompute');
  recompute.addEventListener('click', () => {
    // Recalcula contadores e, de quebra, preenche V/D de registros antigos.
    void busy(recompute, () =>
      repairResults()
        .then((r) => say(`Contadores recalculados: ${fmtInt(r.matches)} partidas revisadas`))
        .catch(() => recomputeAllCounters().then(() => say('Contadores recalculados'))),
    ).then(refresh);
  });

  $('wipe').addEventListener('click', () => {
    if (!confirm('Apagar TODO o histórico local? Isso não tem volta.')) return;
    if (!confirm('Confirma mesmo? Exporte antes se quiser guardar.')) return;
    void wipe()
      .then(() => say('Banco apagado'))
      .then(refresh);
  });

  // Busca embutida na lista: vazia mostra o ranking, com texto mostra os resultados.
  let timer: ReturnType<typeof setTimeout> | undefined;
  ($('search') as HTMLInputElement).addEventListener('input', (ev) => {
    query = (ev.target as HTMLInputElement).value.trim();
    clearTimeout(timer);
    timer = setTimeout(() => {
      const q = query;
      const target = $('top');
      if (!q) {
        void getTopEncounters(20).then((rows) => {
          if (!query) renderList(target, rows, { ranked: true });
        });
        return;
      }
      void searchPlayers(q).then((rows) => {
        if (query !== q) return; // resposta atrasada de uma busca antiga
        renderList(target, rows, {
          emptyTitle: `Nada para "${q}"`,
          emptyHint: 'Tente o id numérico ou um nick antigo.',
        });
      });
    }, 150);
  });

  $('me-maps').addEventListener('click', () => {
    const box = $('identity');
    const gcId = Number(box.dataset.gcId);
    if (!gcId) return;
    const lvl = Number(box.dataset.level);
    void openMapsModal(gcId, $('me-nick').textContent ?? `#${gcId}`, Number.isFinite(lvl) ? lvl : null);
  });

  wireMapsModal();
  wireGroup();
  wireNav();
}

/** Destaca na sidebar a seção visível. Sem listener de scroll: IntersectionObserver. */
function wireNav(): void {
  const links = [...document.querySelectorAll<HTMLAnchorElement>('.nav a')];
  const byId = new Map(links.map((a) => [a.getAttribute('href')?.slice(1) ?? '', a]));
  const sections = [...document.querySelectorAll<HTMLElement>('[data-nav]')];
  if (!('IntersectionObserver' in window) || sections.length === 0) return;

  const visible = new Map<string, number>();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const en of entries) visible.set(en.target.id, en.isIntersecting ? en.intersectionRatio : 0);
      let best = '';
      let bestRatio = 0;
      for (const s of sections) {
        const r = visible.get(s.id) ?? 0;
        if (r > bestRatio) {
          best = s.id;
          bestRatio = r;
        }
      }
      if (!best) return;
      for (const [id, a] of byId) a.classList.toggle('is-active', id === best);
    },
    { rootMargin: '-15% 0px -55% 0px', threshold: [0, 0.2, 0.5, 0.8, 1] },
  );
  for (const s of sections) observer.observe(s);
}

wire();

/**
 * Atualiza os numeros enquanto o backfill roda no worker.
 * A falha NAO e engolida: um `catch` mudo aqui deixou a tela congelada sem avisar,
 * e tela congelada mentindo e pior que tela com erro na cara.
 */
function tick(): void {
  void refresh().catch((err: unknown) => {
    log.error('refresh falhou', err);
    const alert = $('alert');
    alert.hidden = false;
    alert.textContent = `Falha ao ler o banco local: ${String(err)}`;
  });
}

tick();
setInterval(tick, 2000);
