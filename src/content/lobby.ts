/**
 * Overlay de reencontros. Roda em TODA a GC, não só no /lobby: a tela de
 * confirmação de partida é um modal que aparece por cima de qualquer página, então
 * limitar a rota deixaria de fora justamente o momento mais útil.
 *
 * Dois modos de desenho, escolhidos POR ELEMENTO e não por rota — as duas telas
 * convivem na mesma URL (/lobby mostra o grid de salas e, dentro de uma sala, a
 * lista do time):
 *
 * - **camada**, quando o link é só o avatar, sem nick escrito: é o grid apertado,
 *   onde qualquer elemento inline empurra os vizinhos e quebra o layout. O selo vai
 *   numa camada presa ao <body>, posicionado por coordenada, com texto curto ("4x").
 * - **inline**, quando o link traz o nick: aí sobra espaço na linha e o selo entra
 *   ao lado do nome, por extenso, que é mais útil.
 *
 * Read-only: desenha e nada mais. Nenhum clique disparado na plataforma (spec §3.1).
 */
import { guard, log } from '@/lib/log';
import { send } from '@/lib/messages';
import { createBadge, createChip } from '@/ui/badge';
import { markOurs, observeChanges, OUR_ATTR } from './shared/dom';
import { extractPlayerId } from './shared/parser';
import { PLAYER_LINK } from './shared/selectors';
import type { Encounter, Meta, PlayerId } from '@/types';
import type { SharedMatch } from '@/db/repo';

/** O perfil tem cartão próprio (content/profile.ts); aqui seria selo duplicado. */
const isProfilePage = (): boolean => /^\/(player|jogador)\//.test(location.pathname);

/** Marca no link do site usada pelo modo inline. */
const MARK = 'data-gc-enc-done';

/**
 * Nick de verdade tem letras. O link do avatar no grid de salas também tem texto —
 * o número do nível ("13", "15") mora dentro dele —, então testar "tem texto" não
 * serve: era isso que devolvia o selo por extenso para o grid e quebrava o layout.
 */
const NICK_RE = /\p{L}{2,}/u;

function wantsInline(el: Element): boolean {
  return NICK_RE.test((el.textContent ?? '').trim());
}

const handlers = {
  loadMatches: async (gcId: number): Promise<SharedMatch[]> =>
    (await send<SharedMatch[]>({ type: 'getSharedMatches', gcId })) ?? [],
  saveNote: async (gcId: number, note: string): Promise<void> => {
    await send({ type: 'setNote', gcId, note });
  },
};

let myGcId: PlayerId | null = null;
let layer: HTMLElement | null = null;

/** Âncora (link do jogador) -> selo desenhado sobre ela. */
const drawn = new Map<Element, HTMLElement>();
/** Ids já consultados, com ou sem reencontro — evita reconsulta a cada mutação. */
const asked = new Map<PlayerId, Encounter | null>();

function ensureLayer(): HTMLElement {
  if (layer?.isConnected) return layer;
  const host = markOurs(document.createElement('div'), 'layer');
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483500;pointer-events:none';
  document.body.append(host);
  layer = host;
  return host;
}

/** Posiciona cada selo sobre o canto do avatar, sem tocar no DOM do site. */
function place(): void {
  for (const [anchor, chip] of drawn) {
    if (!anchor.isConnected) {
      chip.remove();
      drawn.delete(anchor);
      continue;
    }
    const r = anchor.getBoundingClientRect();
    const visible =
      r.width > 0 &&
      r.height > 0 &&
      r.bottom > 0 &&
      r.right > 0 &&
      r.top < window.innerHeight &&
      r.left < window.innerWidth;
    if (!visible) {
      chip.style.display = 'none';
      continue;
    }
    chip.style.display = 'block';
    chip.style.left = `${Math.round(r.right - 16)}px`;
    chip.style.top = `${Math.round(r.top - 6)}px`;
  }
}

/** Links de jogador ainda sem selo, já com o modo decidido para cada um. */
function pendingLinks(): { el: Element; gcId: PlayerId; inline: boolean }[] {
  const out: { el: Element; gcId: PlayerId; inline: boolean }[] = [];
  for (const el of document.querySelectorAll(PLAYER_LINK)) {
    if (el.closest(`[${OUR_ATTR}]`)) continue;
    if (drawn.has(el) || el.hasAttribute(MARK)) continue;
    const gcId = extractPlayerId(el.getAttribute('href'));
    if (gcId === null || gcId === myGcId) continue;
    out.push({ el, gcId, inline: wantsInline(el) });
  }
  return out;
}

/** Consulta só os ids ainda desconhecidos; a lista de salas re-renderiza sem parar. */
async function resolve(ids: PlayerId[]): Promise<void> {
  const unknown = [...new Set(ids)].filter((id) => !asked.has(id));
  if (unknown.length === 0) return;
  const found = (await send<Encounter[]>({ type: 'getEncounters', gcIds: unknown })) ?? [];
  const byId = new Map(found.map((e) => [e.gcId, e]));
  for (const id of unknown) asked.set(id, byId.get(id) ?? null);
}

async function paint(): Promise<void> {
  const pending = pendingLinks();
  if (pending.length === 0) {
    place();
    return;
  }

  await resolve(pending.map((p) => p.gcId));

  for (const { el, gcId, inline } of pending) {
    const enc = asked.get(gcId);

    if (inline) {
      // Marca mesmo sem reencontro: evita reprocessar o link a cada mutação.
      el.setAttribute(MARK, '1');
      if (!enc) continue; // nunca visto -> nada desenhado (spec §7 fase 3)
      const badge = createBadge(enc, handlers);
      if (badge) el.insertAdjacentElement('afterend', badge);
      continue;
    }

    if (!enc) continue;
    const chip = createChip(enc, handlers);
    if (!chip) continue;
    chip.style.position = 'absolute';
    ensureLayer().append(chip);
    drawn.set(el, chip);
  }

  place();
}

async function run(): Promise<void> {
  if (isProfilePage()) return;

  myGcId = (await send<Meta>({ type: 'getMeta' }))?.myGcId ?? null;
  await paint();

  // A lista de salas e a tela de confirmação trocam o DOM inteiro a toda hora.
  observeChanges(document.body, () => void guard('lobby/repaint', paint));
  // Rolagem e redimensionamento não mudam o DOM, mas movem os avatares.
  window.addEventListener('scroll', place, { capture: true, passive: true });
  window.addEventListener('resize', place, { passive: true });
  log.debug('overlay ativo');
}

void guard('content/lobby', run);
