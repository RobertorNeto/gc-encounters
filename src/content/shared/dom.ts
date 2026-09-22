/**
 * Helpers de espera/observação de DOM. Sem setTimeout chutado (spec §4.5):
 * o gatilho é sempre MutationObserver, com timeout apenas como desistência.
 */

export interface WaitOptions {
  root?: ParentNode;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Resolve assim que algum dos seletores existir. `null` se o timeout estourar. */
export function waitFor(selectors: string[], opts: WaitOptions = {}): Promise<Element | null> {
  const root = opts.root ?? document;
  const timeoutMs = opts.timeoutMs ?? 15000;

  const find = (): Element | null => {
    for (const sel of selectors) {
      const el = root.querySelector(sel);
      if (el) return el;
    }
    return null;
  };

  const immediate = find();
  if (immediate) return Promise.resolve(immediate);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (el: Element | null) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve(el);
    };
    const onAbort = () => finish(null);
    const observer = new MutationObserver(() => {
      const el = find();
      if (el) finish(el);
    });
    const timer = setTimeout(() => finish(null), timeoutMs);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    observer.observe(root instanceof Document ? root.documentElement : (root as Node), {
      childList: true,
      subtree: true,
    });
  });
}

/**
 * Chama `onChange` quando o DOM muda, agrupado por animation frame.
 * A lobby re-renderiza em rajada; sem coalescência o overlay pisca.
 */
export function observeChanges(
  target: Node,
  onChange: () => void,
  opts: MutationObserverInit = { childList: true, subtree: true },
): () => void {
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    onChange();
  };
  const observer = new MutationObserver((records) => {
    // Ignora mutações causadas pela própria extensão, senão o observer se realimenta.
    const external = records.some((r) => !isOurs(r.target) && !addedByUs(r));
    if (!external || scheduled) return;
    scheduled = true;
    requestAnimationFrame(flush);
  });
  observer.observe(target, opts);
  return () => observer.disconnect();
}

export const OUR_ATTR = 'data-gc-encounters';

function isOurs(node: Node): boolean {
  const el = node instanceof Element ? node : node.parentElement;
  return Boolean(el?.closest(`[${OUR_ATTR}]`));
}

function addedByUs(record: MutationRecord): boolean {
  const nodes = [...record.addedNodes, ...record.removedNodes];
  return nodes.length > 0 && nodes.every((n) => isOurs(n));
}

/** Marca um nó como nosso, para o observer e para a limpeza. */
export function markOurs<T extends Element>(el: T, kind: string): T {
  el.setAttribute(OUR_ATTR, kind);
  return el;
}

export function firstMatch(root: ParentNode, candidates: string[]): Element | null {
  for (const sel of candidates) {
    const el = root.querySelector(sel);
    if (el) return el;
  }
  return null;
}

export function allMatches(root: ParentNode, candidates: string[]): Element[] {
  for (const sel of candidates) {
    const els = [...root.querySelectorAll(sel)];
    if (els.length > 0) return els;
  }
  return [];
}

export function text(el: Element | null | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** Primeiro inteiro encontrado no texto/atributos. `null` quando não há — nunca 0 chutado. */
export function firstInt(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = value.match(/-?\d+/);
  return m ? Number(m[0]) : null;
}
