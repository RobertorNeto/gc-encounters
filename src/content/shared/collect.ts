/**
 * Cola entre o parser puro e uma página real: escolhe a fonte (JSON embutido antes
 * de HTML) e devolve sempre um Result, nunca uma exceção.
 */
import { fail, ok, type Result } from '@/lib/result';
import type { MatchRecord } from '@/types';
import { parseMatchDom, parseMatchJson, type ParseContext } from './parser';

/** Blocos JSON que a página já trouxe no HTML. Não é requisição nova. */
function embeddedJson(doc: Document): unknown[] {
  const out: unknown[] = [];
  const nodes = doc.querySelectorAll('script[type="application/json"], script#__NEXT_DATA__');
  for (const node of nodes) {
    const raw = node.textContent;
    if (!raw || raw.length > 4_000_000) continue;
    try {
      out.push(JSON.parse(raw));
    } catch {
      // bloco não é JSON válido: ignora, o HTML ainda é fallback
    }
  }
  return out;
}

/** Procura, em profundidade limitada, um nó que o parser de JSON aceite. */
function deepParse(value: unknown, ctx: ParseContext, depth = 0): Result<MatchRecord> | null {
  if (depth > 6 || typeof value !== 'object' || value === null) return null;
  const direct = parseMatchJson(value, ctx);
  if (direct.ok) return direct;
  const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  for (const child of children) {
    const found = deepParse(child, ctx, depth + 1);
    if (found?.ok) return found;
  }
  return null;
}

/**
 * Fonte primária: JSON interno, quando existir (spec §4.2). HTML é fallback.
 * Os dois caminhos passam pela mesma validação — nenhum grava registro parcial.
 */
export function parseMatchDocument(doc: Document, ctx: ParseContext): Result<MatchRecord> {
  for (const blob of embeddedJson(doc)) {
    const res = deepParse(blob, ctx);
    if (res?.ok) return res;
  }
  const dom = parseMatchDom(doc, ctx);
  if (dom.ok) return dom;
  return fail(dom.stage, `${dom.reason} (sem JSON interno utilizavel)`);
}

/** Usado pelo backfill: HTML cru já baixado pela aba -> MatchRecord. */
export function parseMatchHtml(html: string, ctx: ParseContext): Result<MatchRecord> {
  if (!html.trim()) return fail('fetch:empty', 'resposta vazia');
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // Página de login/erro devolvida no lugar da partida: não é falha de parser.
  if (!doc.querySelector('a[href*="/jogador/"], a[href*="/player/"]')) {
    return fail('fetch:unauthenticated', 'pagina sem jogadores — sessao expirada?');
  }
  return parseMatchDocument(doc, ctx);
}

export { ok };
