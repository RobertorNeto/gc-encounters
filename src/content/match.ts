/**
 * Coleta na página de uma partida finalizada.
 *
 * Fonte primária: o JSON interno `/lobby/match/<id>/1`, o mesmo que a própria página
 * pede. Imune a mudança de CSS. O HTML entra só como fallback.
 * Read-only: nenhum clique, nenhum submit, nenhuma ação na plataforma.
 */
import { guard, log } from '@/lib/log';
import { send } from '@/lib/messages';
import { waitFor } from './shared/dom';
import { parseMatchDocument } from './shared/collect';
import { matchApiPath, parseMatchApi } from './shared/gc-api';
import { detectMyGcId, extractMatchId, type ParseContext } from './shared/parser';
import { READY_HINTS } from './shared/selectors';
import type { MatchRecord } from '@/types';
import { isSkip, type Result } from '@/lib/result';
import type { Meta } from '@/types';

async function fromApi(matchId: string, ctx: ParseContext): Promise<Result<MatchRecord> | null> {
  try {
    const res = await fetch(matchApiPath(matchId), { credentials: 'same-origin' });
    if (!res.ok) return null;
    return parseMatchApi(await res.json(), ctx);
  } catch (err) {
    log.debug('API da partida indisponivel, caindo para o HTML', err);
    return null;
  }
}

async function run(): Promise<void> {
  const matchId = extractMatchId(location.pathname);
  if (!matchId) return;

  await waitFor(READY_HINTS.match, { timeoutMs: 20000 });

  let myGcId = (await send<Meta>({ type: 'getMeta' }))?.myGcId ?? null;
  const detected = detectMyGcId(document);
  if (detected !== null && detected !== myGcId) {
    await send({ type: 'setMyGcId', gcId: detected });
    myGcId = detected;
  }
  if (myGcId === null) {
    log.warn('myGcId desconhecido; defina seu id na pagina de opcoes');
    return;
  }

  const ctx: ParseContext = { myGcId, matchId, url: location.href };
  const res = (await fromApi(matchId, ctx)) ?? parseMatchDocument(document, ctx);

  if (!res.ok) {
    // Partida de outra pessoa nao e defeito: nao grava, nao alerta, nao polui o log.
    if (isSkip(res)) {
      log.debug('partida ignorada', res.stage, res.reason);
      return;
    }
    await send({
      type: 'reportFailure',
      failure: { url: location.href, at: Date.now(), reason: res.reason, stage: res.stage },
    });
    log.warn('parse reprovado', res.stage, res.reason);
    return;
  }

  const saved = await send<{ inserted: boolean; players: number }>({
    type: 'saveMatch',
    record: res.value,
    source: 'live',
  });
  log.debug('partida gravada', matchId, saved);
}

void guard('content/match', run);
