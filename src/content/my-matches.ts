/**
 * /my-matches: aproveita a visita para descobrir meu id e enfileirar as partidas
 * recentes. Uma requisicao, mais nada.
 *
 * A varredura do historico NAO acontece aqui — ela roda no service worker, que
 * continua com a aba fechada (src/background/backfill.ts).
 */
import { guard, log } from '@/lib/log';
import { send } from '@/lib/messages';
import { historyApiPath, parseHistoryApi } from './shared/gc-api';
import type { Meta } from '@/types';

async function run(): Promise<void> {
  const meta = await send<Meta>({ type: 'getMeta' });
  if (!meta) return;

  const path = historyApiPath('latest', 1);
  try {
    const res = await fetch(path, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const parsed = parseHistoryApi(await res.json());

    if (!parsed.ok) {
      await send({
        type: 'reportFailure',
        failure: { url: path, at: Date.now(), reason: parsed.reason, stage: parsed.stage },
      });
      return;
    }

    if (parsed.value.myGcId !== null && parsed.value.myGcId !== meta.myGcId) {
      await send({ type: 'setMyGcId', gcId: parsed.value.myGcId });
    }
    // Enfileira sem mexer no cursor nem na lista de meses: isso e do worker.
    await send({
      type: 'backfill:enqueue',
      matchIds: parsed.value.matchIds,
      periods: parsed.value.periods,
    });
    log.debug('historico recente enfileirado', parsed.value.matchIds.length);
  } catch (err) {
    log.warn('leitura do historico falhou', err);
  }
}

void guard('content/my-matches', run);
