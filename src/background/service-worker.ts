/**
 * Service worker: dono do banco e da máquina de estado do backfill.
 *
 * Ele NÃO faz requisição à GC. Quem busca e parseia é o content script da aba de
 * /minhas-partidas, que já roda na origem autenticada e tem DOMParser (o worker MV3
 * não tem). O worker só guarda fila, cursor, contadores de falha e impõe o throttle.
 */
import { MAX_CONSECUTIVE_FAILURES, MIN_THROTTLE_MS } from '@/config/constants';
import {
  clearFailure,
  exportAll,
  getEncounters,
  getMeta,
  getSharedMatches,
  getKnownMatchIds,
  getStats,
  getTopEncounters,
  importAll,
  recordFailure,
  repairResults,
  saveMatch,
  searchPlayers,
  setNote,
  updateMeta,
  wipe,
} from '@/db/repo';
import { log } from '@/lib/log';
import { SKIP } from '@/lib/result';
import { resume, detectMyGcId, retryFailed } from './backfill';
import type { BackfillJob, Msg, MsgResult } from '@/lib/messages';
import type { BackfillState } from '@/types';

/** Último instante em que um job de backfill foi liberado. Só na memória do worker. */
let lastJobAt = 0;

async function patchBackfill(patch: Partial<BackfillState>): Promise<BackfillState> {
  const meta = await getMeta();
  const backfill: BackfillState = { ...meta.backfill, ...patch, updatedAt: Date.now() };
  await updateMeta({ backfill });
  return backfill;
}

/** Entrega o próximo matchId da fila e quanto esperar antes de buscá-lo. */
async function nextJob(): Promise<BackfillJob | null> {
  const meta = await getMeta();
  const bf = meta.backfill;
  if (bf.status !== 'running') return null;
  const [matchId, ...rest] = bf.queue;
  if (!matchId) return null;
  await patchBackfill({ queue: rest });
  const interval = Math.max(MIN_THROTTLE_MS, meta.throttleMs);
  const waitMs = Math.max(0, lastJobAt + interval - Date.now());
  lastJobAt = Date.now() + waitMs;
  return { matchId, waitMs };
}

async function onResult(
  matchId: string,
  okResult: boolean,
  reason?: string,
  skipped = false,
): Promise<BackfillState> {
  const meta = await getMeta();
  const bf = meta.backfill;
  if (okResult) {
    // Pulada nao entra na conta de partidas coletadas, mas tambem nao e falha.
    const matchesDone = skipped ? bf.matchesDone : bf.matchesDone + 1;
    return patchBackfill({ matchesDone, consecutiveFailures: 0 });
  }
  const failures = bf.consecutiveFailures + 1;
  log.warn('backfill falhou', matchId, reason);
  if (failures >= MAX_CONSECUTIVE_FAILURES) {
    // Para sozinho: melhor parar do que martelar o site (spec §7 fase 2).
    return patchBackfill({ status: 'error', consecutiveFailures: failures });
  }
  return patchBackfill({ consecutiveFailures: failures });
}

async function enqueue(matchIds: string[], periods?: string[]): Promise<BackfillState> {
  const meta = await getMeta();
  const bf = meta.backfill;
  const known = new Set(bf.queue);
  const collected = await getKnownMatchIds();
  // Partida ja no banco nao volta para a fila: reprocessar seria requisicao a toa.
  const fresh = matchIds.filter((id) => !known.has(id) && !collected.has(id));

  const patch: Partial<BackfillState> = { queue: [...bf.queue, ...fresh] };

  // A lista de meses so e aceita numa varredura que ainda nao comecou. Depois disso
  // ela pertence ao motor: aceitar de novo rebobinaria o progresso (a aba de
  // /my-matches manda sempre os 65 meses, e isso ressuscitava meses ja visitados).
  if (periods && periods.length > 0 && bf.periods.length === 0 && bf.pagesDone === 0) {
    patch.periods = periods;
  }

  // O cursor NAO vem de fora. Quem anda com ele e o backfill.ts, e so ele.
  return patchBackfill(patch);
}

/** Consome o proximo mes da lista; o cursor volta para a aba conduzir. */
async function takePeriod(): Promise<string | null> {
  const meta = await getMeta();
  const [next, ...rest] = meta.backfill.periods;
  if (!next) return null;
  await patchBackfill({ periods: rest });
  return next;
}

async function control(
  action: 'start' | 'pause' | 'reset' | 'finishPage' | 'retryFailed',
): Promise<BackfillState | { queued: number }> {
  switch (action) {
    case 'retryFailed':
      return { queued: await retryFailed() };
    case 'start': {
      const state = await patchBackfill({
        status: 'running',
        consecutiveFailures: 0,
        startedAt: Date.now(),
      });
      // Nao espera o laco terminar: a resposta volta na hora e a varredura segue.
      void resume();
      return state;
    }
    case 'pause':
      return patchBackfill({ status: 'paused' });
    case 'finishPage':
      return patchBackfill({ status: 'done', cursor: null });
    case 'reset':
      return patchBackfill({
        status: 'idle',
        cursor: null,
        queue: [],
        periods: [],
        oldestPeriod: null,
        emptyMonths: 0,
        pagesDone: 0,
        matchesDone: 0,
        consecutiveFailures: 0,
        startedAt: null,
        failed: [],
      });
  }
}

async function handle(msg: Msg): Promise<unknown> {
  switch (msg.type) {
    case 'ping':
      return 'pong';
    case 'saveMatch': {
      const res = await saveMatch(msg.record, msg.source);
      await clearFailure();
      return res;
    }
    case 'getEncounters':
      return [...(await getEncounters(msg.gcIds)).values()];
    case 'getSharedMatches':
      return getSharedMatches(msg.gcId, msg.limit ?? 20);
    case 'setNote':
      return setNote(msg.gcId, msg.note);
    case 'reportFailure':
      return recordFailure(msg.failure);
    case 'setMyGcId': {
      const meta = await getMeta();
      if (meta.myGcId === msg.gcId) return meta;
      return updateMeta({ myGcId: msg.gcId });
    }
    case 'getMeta':
      return getMeta();
    case 'setThrottle':
      return updateMeta({ throttleMs: msg.ms });
    case 'getStats':
      return getStats();
    case 'getTop':
      return getTopEncounters(msg.limit ?? 20);
    case 'search':
      return searchPlayers(msg.query);
    case 'export':
      return exportAll();
    case 'import':
      return importAll(msg.dump);
    case 'wipe':
      return wipe();
    case 'repairResults':
      return repairResults();
    case 'detectMyId':
      // Botao das opcoes: sempre consulta a sessao, mesmo com id ja salvo, para
      // renovar nick e nivel.
      return detectMyGcId(true);
    case 'backfill:enqueue':
      return enqueue(msg.matchIds, msg.periods);
    case 'backfill:takePeriod':
      return takePeriod();
    case 'backfill:next':
      return nextJob();
    case 'backfill:result':
      return onResult(msg.matchId, msg.okResult, msg.reason, msg.skipped);
    case 'backfill:control':
      return control(msg.action);
  }
}

chrome.runtime.onMessage.addListener((msg: Msg, _sender, sendResponse) => {
  handle(msg)
    .then((value) => sendResponse({ ok: true, value } satisfies MsgResult))
    .catch((err: unknown) => {
      log.error('handler falhou', msg?.type, err);
      sendResponse({ ok: false, error: String(err) } satisfies MsgResult);
    });
  return true; // resposta assíncrona
});

/**
 * Partidas coletadas antes do campo `result` existirem ficam sem V/D.
 * Uma passada, uma vez, marcada em meta — depois disso todo save ja grava.
 */
async function ensureResultsRepaired(): Promise<void> {
  const meta = await getMeta();
  if (meta.resultsRepairedAt) return;
  const res = await repairResults();
  await updateMeta({ resultsRepairedAt: Date.now() });
  log.info('resultados preenchidos', res);
}

/** Alertas gravados quando "nao e minha partida" ainda contava como falha. */
const STALE_FAILURE_STAGES = ['api:me', 'match:me'];

async function clearStaleFailure(): Promise<void> {
  const meta = await getMeta();
  const stage = meta.lastFailure?.stage;
  if (!stage) return;
  if (stage.startsWith(SKIP) || STALE_FAILURE_STAGES.includes(stage)) {
    await clearFailure();
    log.info('alerta antigo descartado:', stage);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  // Abre o banco cedo para rodar as migrações fora do caminho crítico.
  void getMeta().then((m) => log.info('pronto; schema v' + m.schemaVersion));
});

/**
 * O service worker MV3 e desligado com ~30 s ocioso. O alarme o acorda e o laco
 * recomeca do cursor — e por isso que o backfill sobrevive sem aba aberta.
 */
const HEARTBEAT = 'gc-encounters:backfill';

chrome.alarms.create(HEARTBEAT, { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== HEARTBEAT) return;
  void resume().catch((err: unknown) => log.error('retomada falhou', err));
});

/**
 * Clique no icone abre a pagina da extensao numa aba.
 * Sem popup de proposito: a tela tem tabela, busca e gaveta de partidas — nao cabe
 * nos ~800px de um popup.
 */
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(() => {
  void resume().catch((err: unknown) => log.error('retomada no boot falhou', err));
});

void ensureResultsRepaired().catch((err: unknown) => log.error('reparo falhou', err));
// Sem id definido, tenta descobrir sozinho — uma requisicao, so quando falta.
void detectMyGcId().catch((err: unknown) => log.debug('deteccao de id adiada', err));
// Worker acordou por qualquer motivo: se o backfill estava ligado, ele continua.
void resume().catch((err: unknown) => log.error('retomada falhou', err));
void clearStaleFailure().catch((err: unknown) => log.error('limpeza de alerta falhou', err));
