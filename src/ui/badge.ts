/**
 * Selo de reencontro. Vive dentro de um shadow root: o CSS da GC não vaza para cá
 * e o nosso não vaza para lá. Nunca cobre elemento clicável — é inline, ao lado do
 * nick, com pointer-events só no próprio selo.
 */
import { markOurs, OUR_ATTR } from '@/content/shared/dom';
import type { Encounter } from '@/types';
import type { SharedMatch } from '@/db/repo';

const STYLE = `
:host { all: initial; display: inline-block; vertical-align: middle; }
:host(.panel-host) { display: block; }
.badge {
  font: 500 11px/1.4 system-ui, sans-serif;
  color: #e8e8ea;
  background: rgba(255,255,255,.08);
  border: 1px solid rgba(255,255,255,.14);
  border-radius: 999px;
  padding: 1px 7px;
  margin-left: 6px;
  cursor: pointer;
  white-space: nowrap;
  user-select: none;
}
.badge:hover { background: rgba(255,255,255,.16); }
.badge.hot { border-color: #f2a13d55; color: #f7c07a; }
.panel {
  position: fixed;
  z-index: 2147483600;
  width: 320px;
  max-height: 60vh;
  overflow: auto;
  overscroll-behavior: contain;
  background: #16171b;
  color: #e8e8ea;
  border: 1px solid rgba(255,255,255,.14);
  border-radius: 8px;
  padding: 10px 12px;
  font: 400 12px/1.5 system-ui, sans-serif;
  box-shadow: 0 12px 32px rgba(0,0,0,.5);
}
.panel h4 { margin: 0 0 2px; font-size: 12px; font-weight: 600; }
.panel .record { margin: 0 0 8px; font-size: 11px; opacity: .85; }
.panel .record b { font-weight: 600; }
.panel .win { color: #7bc47f; }
.panel .loss { color: #e2574c; }
.panel .unknown { opacity: .55; }
.panel ul { list-style: none; margin: 0 0 8px; padding: 0; }
.panel li {
  display: flex; gap: 6px; padding: 2px 0; align-items: baseline;
  border-top: 1px solid rgba(255,255,255,.06);
}
.panel li .vs { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.panel li .tag { font-weight: 600; width: 14px; flex: none; }
.panel a { color: #8ab4f8; text-decoration: none; }
.panel .vs { opacity: .6; }
.panel textarea {
  width: 100%; box-sizing: border-box; min-height: 48px; resize: vertical;
  background: #0f1013; color: inherit; border: 1px solid rgba(255,255,255,.14);
  border-radius: 6px; padding: 6px; font: inherit;
}
@media (prefers-color-scheme: light) {
  .badge { color: #222; background: rgba(0,0,0,.06); border-color: rgba(0,0,0,.12); }
  .panel { background: #fff; color: #222; border-color: rgba(0,0,0,.12); }
  .panel textarea { background: #fafafa; color: #222; border-color: rgba(0,0,0,.14); }
}
`;

export interface BadgeHandlers {
  loadMatches(gcId: number): Promise<SharedMatch[]>;
  saveNote(gcId: number, note: string): Promise<void>;
}

const fmtDate = (ms: number): string =>
  new Date(ms).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });

/** Rota real da partida na GC, confirmada na Fase 0. */
export const matchUrl = (matchId: string): string =>
  `https://gamersclub.com.br/lobby/match/${matchId}`;

/**
 * Percentual sobre as partidas com resultado conhecido, nao sobre o total:
 * partida sem placar legivel nao vira derrota por omissao.
 */
export function winRateText(enc: Encounter): { text: string; rate: number | null } {
  const decided = enc.decided ?? enc.wins + enc.losses + enc.draws;
  if (!decided) return { text: 'sem resultado gravado', rate: null };
  const rate = Math.round((enc.wins / decided) * 100);
  const parts = [`${enc.wins}V`, `${enc.losses}D`];
  if (enc.draws) parts.push(`${enc.draws}E`);
  const missing = enc.total - decided;
  const tail = missing > 0 ? ` · ${missing} sem placar` : '';
  return { text: `${rate}% de vitória (${parts.join(' · ')})${tail}`, rate };
}

/** Nível visto por último. `null` quando a partida não trouxe o dado. */
export const levelText = (enc: Encounter): string =>
  enc.lastLevel === null ? '' : `nv ${enc.lastLevel}`;

export function badgeLabel(enc: Encounter): string {
  const parts: string[] = [];
  if (enc.against) parts.push(`${enc.against} contra`);
  if (enc.together) parts.push(`${enc.together} junto`);
  const detail = parts.length ? ` (${parts.join(' · ')})` : '';
  const last = enc.lastPlayedAt ? ` · último: ${fmtDate(enc.lastPlayedAt)}` : '';
  const level = levelText(enc);
  return `🔁 ${enc.total}x${detail}${level ? ` · ${level}` : ''}${last}`;
}

/** Jogador nunca visto não recebe selo: ruído zero (spec §7 fase 3). */
export function createBadge(enc: Encounter, handlers: BadgeHandlers): HTMLElement | null {
  if (enc.total <= 0) return null;

  const host = markOurs(document.createElement('span'), 'badge');
  host.dataset.gcId = String(enc.gcId);
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = STYLE;

  const badge = document.createElement('span');
  badge.className = enc.total >= 5 ? 'badge hot' : 'badge';
  badge.textContent = badgeLabel(enc);
  badge.title = enc.note ? `anotação: ${enc.note}` : 'clique para ver as partidas em comum';

  let openPanel: (() => void) | null = null;
  const close = () => {
    openPanel?.();
    openPanel = null;
  };

  badge.addEventListener('click', (ev) => {
    // Só o selo consome o clique; o elemento da GC embaixo continua clicável.
    ev.preventDefault();
    ev.stopPropagation();
    if (openPanel) return close();
    openPanel = mountPanel(enc, handlers, badge);
  });

  shadow.append(style, badge);
  return host;
}

/**
 * Monta o painel num host proprio preso ao <body>.
 *
 * Nao pode morar dentro do shadow do selo: os cards da GC usam transform/overflow,
 * e um ancestral com transform faz `position: fixed` se ancorar nele em vez da
 * viewport — era isso que cortava o painel e jogava por cima dos vizinhos.
 * Devolve a funcao que fecha.
 */
export function mountPanel(
  enc: Encounter,
  handlers: BadgeHandlers,
  anchor: HTMLElement,
): () => void {
  // Um painel por vez na pagina inteira.
  for (const old of document.querySelectorAll(`[${OUR_ATTR}="panel"]`)) old.remove();

  const host = markOurs(document.createElement('div'), 'panel');
  host.className = 'panel-host';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = STYLE;

  let closed = false;
  let resize: ResizeObserver;
  const close = () => {
    if (closed) return;
    closed = true;
    host.remove();
    resize.disconnect();
    document.removeEventListener('click', onOutside, true);
    window.removeEventListener('scroll', place, true);
    window.removeEventListener('resize', place);
    document.removeEventListener('keydown', onKey, true);
  };
  const onOutside = (ev: Event) => {
    const target = ev.target as Node;
    if (host.contains(target) || anchor.getRootNode().contains(target)) return;
    close();
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') close();
  };

  const panel = buildPanel(enc, handlers, close);
  shadow.append(style, panel);
  document.body.append(host);

  function place(): void {
    if (closed) return;
    const a = anchor.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    const margin = 8;
    // Cabe abaixo? Senao, abre para cima. Sempre dentro da viewport.
    const below = a.bottom + 6;
    const above = a.top - p.height - 6;
    const top = below + p.height + margin <= window.innerHeight ? below : Math.max(margin, above);
    const left = Math.min(Math.max(margin, a.left), window.innerWidth - p.width - margin);
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
  }

  place();
  // As partidas chegam depois e mudam a altura: reposiciona quando isso acontecer.
  resize = new ResizeObserver(place);
  resize.observe(panel);
  document.addEventListener('click', onOutside, true);
  window.addEventListener('scroll', place, true);
  window.addEventListener('resize', place);
  document.addEventListener('keydown', onKey, true);

  return close;
}

function buildPanel(enc: Encounter, handlers: BadgeHandlers, close: () => void): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'panel';

  const title = document.createElement('h4');
  const level = levelText(enc);
  title.textContent =
    `${enc.nick}${level ? ` · ${level}` : ''} — ${enc.total} partidas em comum`;

  const record = document.createElement('p');
  const { text, rate } = winRateText(enc);
  record.className = rate === null ? 'record unknown' : rate >= 50 ? 'record win' : 'record loss';
  record.textContent = text;

  const list = document.createElement('ul');
  const loading = document.createElement('li');
  loading.textContent = 'carregando…';
  list.append(loading);

  const note = document.createElement('textarea');
  note.placeholder = 'anotação (só sua, fica local)';
  note.value = enc.note ?? '';
  note.addEventListener('change', () => void handlers.saveNote(enc.gcId, note.value));
  note.addEventListener('click', (ev) => ev.stopPropagation());

  panel.append(title, record, list, note);
  panel.addEventListener('click', (ev) => ev.stopPropagation());

  void handlers.loadMatches(enc.gcId).then((matches) => {
    list.textContent = '';
    if (matches.length === 0) {
      const li = document.createElement('li');
      li.textContent = 'sem detalhe gravado';
      list.append(li);
      return;
    }
    for (const m of matches) {
      const li = document.createElement('li');

      const tag = document.createElement('span');
      tag.className = m.result === 'win' ? 'tag win' : m.result === 'loss' ? 'tag loss' : 'tag unknown';
      tag.textContent = m.result === 'win' ? 'V' : m.result === 'loss' ? 'D' : m.result === 'draw' ? 'E' : '–';
      tag.title = m.result ? '' : 'placar nao registrado';

      const when = document.createElement('span');
      when.textContent = new Date(m.playedAt).toLocaleDateString('pt-BR');

      const what = document.createElement('span');
      what.className = 'vs';
      what.textContent = [
        m.relation === 'together' ? 'junto' : 'contra',
        m.levelAtMatch === null ? null : `nv ${m.levelAtMatch}`,
        m.map,
        m.score,
      ]
        .filter(Boolean)
        .join(' · ');

      const link = document.createElement('a');
      link.href = matchUrl(m.matchId);
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = 'ver';

      li.append(tag, when, what, link);
      list.append(li);
    }
  });

  const dismiss = document.createElement('a');
  dismiss.href = '#';
  dismiss.textContent = 'fechar';
  dismiss.addEventListener('click', (ev) => {
    ev.preventDefault();
    close();
  });
  panel.append(dismiss);
  return panel;
}

/** Remove selos órfãos após re-render da página. */
export function clearBadges(root: ParentNode): void {
  for (const el of root.querySelectorAll(`[${OUR_ATTR}="badge"]`)) el.remove();
}

const CHIP_STYLE = `
:host { all: initial; }
.chip {
  display: inline-flex; align-items: center; gap: 2px;
  height: 15px; padding: 0 5px; border-radius: 999px;
  background: #16171b; color: #e8e8ea;
  border: 1px solid rgba(255,255,255,.22);
  box-shadow: 0 2px 6px rgba(0,0,0,.5);
  font: 700 10px/1 system-ui, sans-serif;
  cursor: pointer; pointer-events: auto; user-select: none;
  white-space: nowrap;
}
.chip:hover { border-color: #f2a13d; }
.chip.hot { background: #3a2a12; color: #f7c07a; border-color: #f2a13d88; }
`;

/**
 * Selo compacto para a camada de overlay: so o numero.
 *
 * Em grid apertado (lista de salas, lobby) o selo com texto empurrava os vizinhos
 * e quebrava o layout da GC. Este nao entra no fluxo: quem posiciona e a camada.
 */
export function createChip(enc: Encounter, handlers: BadgeHandlers): HTMLElement | null {
  if (enc.total <= 0) return null;

  const host = markOurs(document.createElement('div'), 'chip');
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = CHIP_STYLE;

  const chip = document.createElement('span');
  chip.className = enc.total >= 5 ? 'chip hot' : 'chip';
  chip.textContent = `${enc.total}x`;
  // O texto fica curto de proposito (o grid e apertado); o detalhe vai no hover.
  chip.title = badgeLabel(enc);

  let close: (() => void) | null = null;
  chip.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (close) {
      close();
      close = null;
      return;
    }
    close = mountPanel(enc, handlers, chip);
  });

  shadow.append(style, chip);
  return host;
}
