/**
 * Perfil (`/player/<id>`): mostra, de forma visível, quantas vezes eu já cruzei com
 * essa pessoa. Diferente da lobby, aqui a pergunta é explícita — você abriu o perfil
 * para saber — então mesmo "nunca joguei" é resposta útil e aparece.
 *
 * O layout do perfil não foi mapeado na Fase 0: o cartão é fixo no canto e não
 * depende de seletor nenhum. Se o cabeçalho for reconhecido, um selo compacto
 * também entra ao lado do nick.
 */
import { guard, log } from '@/lib/log';
import { send } from '@/lib/messages';
import { createBadge } from '@/ui/badge';
import { markOurs, observeChanges, OUR_ATTR, waitFor } from './shared/dom';
import { extractPlayerId } from './shared/parser';
import type { Encounter, Meta, PlayerId } from '@/types';
import type { SharedMatch } from '@/db/repo';

const CARD = 'profile-card';

/** Onde encaixar o selo compacto, em ordem de preferência. */
const ANCHOR_CANDIDATES = [
  '[class*="ProfileHeader"] [class*="nick" i]',
  '[class*="profile" i] h1',
  '[class*="Profile"] [class*="name" i]',
  'h1',
];

const handlers = {
  loadMatches: async (gcId: number): Promise<SharedMatch[]> =>
    (await send<SharedMatch[]>({ type: 'getSharedMatches', gcId, limit: 50 })) ?? [],
  saveNote: async (gcId: number, note: string): Promise<void> => {
    await send({ type: 'setNote', gcId, note });
  },
};

function card(): HTMLElement {
  const box = markOurs(document.createElement('div'), CARD);
  const shadow = box.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
:host { all: initial; }
.box {
  /* Topo direito, abaixo do cabecalho fixo da GC. */
  position: fixed; right: 16px; top: 88px; z-index: 2147483000;
  display: flex; align-items: center; gap: 10px;
  padding: 10px 12px; border-radius: 12px;
  background: rgba(20,21,25,.96); color: #e8e8ea;
  border: 1px solid rgba(255,255,255,.14);
  box-shadow: 0 12px 34px rgba(0,0,0,.5);
  font: 500 12px/1.4 system-ui, sans-serif;
}
.count { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; }
.count.hot { color: #f7c07a; }
.count.zero { color: #9a9aa2; font-size: 13px; font-weight: 500; }
.txt { display: flex; flex-direction: column; gap: 1px; }
.sub { font-size: 11px; opacity: .65; font-weight: 400; }
.rate { font-weight: 600; }
.rate.good { color: #7bc47f; }
.rate.bad { color: #e2574c; }
.slot { margin-left: 2px; }
`;
  const box2 = document.createElement('div');
  box2.className = 'box';
  shadow.append(style, box2);
  document.body.append(box);
  return box2;
}

function fillCard(root: HTMLElement, enc: Encounter | null): HTMLElement {
  const count = document.createElement('span');
  const txt = document.createElement('span');
  txt.className = 'txt';

  const title = document.createElement('span');
  const sub = document.createElement('span');
  sub.className = 'sub';

  if (!enc) {
    count.className = 'count zero';
    count.textContent = '—';
    title.textContent = 'nunca cruzei com esse jogador';
    sub.textContent = 'ou a partida ainda não foi coletada';
  } else {
    count.className = enc.total >= 5 ? 'count hot' : 'count';
    count.textContent = `${enc.total}x`;
    const level = enc.lastLevel === null ? '' : ` · nv ${enc.lastLevel}`;
    title.textContent = `${enc.against} contra · ${enc.together} junto${level}`;

    const decided = enc.decided ?? enc.wins + enc.losses + enc.draws;
    if (decided) {
      const pct = Math.round((enc.wins / decided) * 100);
      const rate = document.createElement('b');
      rate.className = pct >= 50 ? 'rate good' : 'rate bad';
      rate.textContent = `${pct}% de vitória`;
      sub.append(rate, document.createTextNode(` (${enc.wins}V · ${enc.losses}D)`));
    } else {
      sub.textContent = 'sem placar registrado';
    }
  }

  txt.append(title, sub);
  root.append(count, txt);
  return root;
}

function clear(): void {
  for (const el of document.querySelectorAll(`[${OUR_ATTR}]`)) el.remove();
}

async function paint(gcId: PlayerId): Promise<void> {
  if (document.querySelector(`[${OUR_ATTR}="${CARD}"]`)) return;

  const found = await send<Encounter[]>({ type: 'getEncounters', gcIds: [gcId] });
  const enc = found?.[0] ?? null;

  const root = fillCard(card(), enc);
  if (!enc) return;

  // O selo do cartão e o do cabeçalho são instâncias separadas do mesmo componente.
  const inCard = createBadge(enc, handlers);
  if (inCard) {
    inCard.classList.add('slot');
    root.append(inCard);
  }

  for (const sel of ANCHOR_CANDIDATES) {
    const anchor = document.querySelector(sel);
    if (!anchor || anchor.closest(`[${OUR_ATTR}]`)) continue;
    const inline = createBadge(enc, handlers);
    if (inline) anchor.insertAdjacentElement('afterend', inline);
    break;
  }
  log.debug('perfil marcado', gcId, enc.total);
}

async function run(): Promise<void> {
  let gcId = extractPlayerId(location.pathname);
  if (gcId === null) return;

  const myGcId = (await send<Meta>({ type: 'getMeta' }))?.myGcId ?? null;
  if (gcId === myGcId) return; // meu próprio perfil não precisa de selo

  await waitFor(ANCHOR_CANDIDATES, { timeoutMs: 15000 });
  await paint(gcId);

  // O perfil é SPA: trocar de jogador não recarrega a página.
  observeChanges(document.body, () => {
    const current = extractPlayerId(location.pathname);
    if (current === null || current === myGcId) return;
    if (current !== gcId) {
      gcId = current;
      clear();
    }
    void guard('profile/repaint', () => paint(current));
  });
}

void guard('content/profile', run);
