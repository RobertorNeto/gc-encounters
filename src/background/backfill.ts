/**
 * Motor do backfill, agora no service worker: roda sem aba da GC aberta.
 *
 * As requisições saem do próprio navegador do usuário, na mesma origem e com a
 * sessão que ele já tem — o Chrome anexa o cookie sozinho por causa das
 * host_permissions. A extensão **não lê, não guarda e não transmite** o `gclubsess`
 * nem token nenhum (spec §3.5), e só fala com domínios da GC (spec §3.6).
 *
 * Ritmo: uma requisição por vez, nunca abaixo de 2500 ms (spec §3.4).
 * Sobrevivência: o worker MV3 morre com 30 s ocioso, então um alarme o ressuscita
 * e o laço recomeça de onde o cursor parou.
 */
import { MAX_CONSECUTIVE_FAILURES, MIN_THROTTLE_MS, isAllowedUrl } from '@/config/constants';
import { getKnownMatchIds, getMeta, recordFailure, saveMatch, updateMeta } from '@/db/repo';
import { log } from '@/lib/log';
import { isSkip } from '@/lib/result';
import { defaultSleep } from '@/lib/throttle';
import {
  historyApiPath,
  matchApiPath,
  parseHistoryApi,
  parseMatchApi,
  parseUserMe,
  USER_ME_PATH,
} from '@/content/shared/gc-api';
import type { BackfillState } from '@/types';

const ORIGIN = 'https://gamersclub.com.br';

/** Quantos meses seguidos sem partida antes de concluir que o histórico acabou. */
const EMPTY_MONTHS_LIMIT = 6;
/** Piso absoluto: a GC não tem partida antes disso. Evita varrer o infinito. */
const FLOOR_PERIOD = '2015-01';

let looping = false;
/** Instante da ultima requisicao, para espacar sem dormir a toa. */
let lastRequestAt = 0;

async function patch(next: Partial<BackfillState>): Promise<BackfillState> {
  const meta = await getMeta();
  const backfill: BackfillState = { ...meta.backfill, ...next, updatedAt: Date.now() };
  await updateMeta({ backfill });
  return backfill;
}

async function fetchJson(path: string): Promise<unknown> {
  lastRequestAt = Date.now();
  const url = `${ORIGIN}${path}`;
  // Cinto de segurança: nenhuma URL fora da GC sai daqui, nunca.
  if (!isAllowedUrl(url)) throw new Error(`url fora da GC: ${url}`);
  const res = await fetch(url, { credentials: 'include', redirect: 'follow' });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`sessao expirada (HTTP ${res.status}) — abra a GC e faca login`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${path}`);
  return res.json();
}

/** "2024-01" -> "2023-12". */
export function previousMonth(period: string): string | null {
  const m = period.match(/^(\d{4})-(\d{2})$/);
  if (!m?.[1] || !m[2]) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  const prevYear = month === 1 ? year - 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;
  return `${prevYear}-${String(prevMonth).padStart(2, '0')}`;
}

/** Ordena "AAAA-MM" lexicograficamente — o formato já é ordenável. */
const olderOf = (a: string | null, b: string | null): string | null => {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
};

export interface Cursor {
  period: string;
  page: number;
}

export function parseCursor(cursor: string | null): Cursor {
  const m = cursor?.match(/^(.+)\/(\d+)$/);
  if (!m?.[1] || !m[2]) return { period: 'latest', page: 1 };
  return { period: m[1], page: Number(m[2]) };
}

export const makeCursor = (period: string, page: number): string => `${period}/${page}`;

/**
 * Decide para onde ir depois de ler uma página.
 * Primeiro esgota as páginas do mês; depois os meses que a GC listou; depois
 * caminha para trás mês a mês, porque a lista de meses da GC não cobre todo o
 * histórico — é assim que partidas anteriores a 2024 são alcançadas.
 */
export function nextCursor(
  current: Cursor,
  found: number,
  lastPage: number | null,
  state: Pick<BackfillState, 'periods' | 'oldestPeriod' | 'emptyMonths' | 'donePeriods'>,
): {
  cursor: string | null;
  periods: string[];
  oldestPeriod: string | null;
  emptyMonths: number;
  donePeriods: string[];
} {
  const oldestPeriod =
    current.period === 'latest' ? state.oldestPeriod : olderOf(state.oldestPeriod, current.period);

  // Ainda ha paginas nesse mes: continua nele, sem marcar nada como concluido.
  if (lastPage !== null && current.page < lastPage) {
    return {
      cursor: makeCursor(current.period, current.page + 1),
      periods: state.periods,
      oldestPeriod,
      emptyMonths: state.emptyMonths,
      donePeriods: state.donePeriods,
    };
  }

  // Mes inteiro lido: entra na lista de concluidos e atualiza a sequencia de vazios.
  const donePeriods =
    current.period === 'latest' || state.donePeriods.includes(current.period)
      ? state.donePeriods
      : [...state.donePeriods, current.period];
  const emptyMonths =
    current.period === 'latest' ? state.emptyMonths : found > 0 ? 0 : state.emptyMonths + 1;

  const done = new Set(donePeriods);
  const isDone = (p: string): boolean =>
    done.has(p) || (oldestPeriod !== null && p >= oldestPeriod);

  // A varredura vai do mes mais novo para o mais antigo: mes ja concluido, ou mais
  // novo que o mais antigo ja visitado, e repeticao — descarta sem requisitar.
  let pending = state.periods;
  while (pending.length > 0 && isDone(pending[0] as string)) pending = pending.slice(1);

  const [head, ...rest] = pending;
  if (head) {
    return { cursor: makeCursor(head, 1), periods: rest, oldestPeriod, emptyMonths, donePeriods };
  }

  if (emptyMonths >= EMPTY_MONTHS_LIMIT) {
    return { cursor: null, periods: [], oldestPeriod, emptyMonths, donePeriods };
  }

  // Caminhada para tras, pulando o que ja foi lido em varreduras anteriores.
  let back = oldestPeriod ? previousMonth(oldestPeriod) : null;
  let guard = 0;
  while (back && done.has(back) && guard < 240) {
    back = previousMonth(back);
    guard += 1;
  }
  if (!back || back < FLOOR_PERIOD) {
    return { cursor: null, periods: [], oldestPeriod, emptyMonths, donePeriods };
  }
  return { cursor: makeCursor(back, 1), periods: [], oldestPeriod: back, emptyMonths, donePeriods };
}

async function advance(): Promise<void> {
  const meta = await getMeta();
  const bf = meta.backfill;
  const cursor = parseCursor(bf.cursor);
  const path = historyApiPath(cursor.period, cursor.page);

  const parsed = parseHistoryApi(await fetchJson(path));
  if (!parsed.ok) {
    await recordFailure({ url: path, at: Date.now(), reason: parsed.reason, stage: parsed.stage });
    await patch({ consecutiveFailures: bf.consecutiveFailures + 1 });
    return;
  }

  const { matchIds, periods, lastPage, myGcId } = parsed.value;
  if (myGcId !== null && meta.myGcId !== myGcId) await updateMeta({ myGcId });

  const collected = await getKnownMatchIds();
  const queued = new Set(bf.queue);
  const fresh = matchIds.filter((id) => !queued.has(id) && !collected.has(id));

  // A primeira leitura ("latest") traz a lista de meses que a GC conhece.
  const known = bf.periods.length > 0 || cursor.period !== 'latest' ? bf.periods : periods;
  const step = nextCursor(cursor, matchIds.length, lastPage, {
    periods: known,
    oldestPeriod: bf.oldestPeriod,
    emptyMonths: bf.emptyMonths,
    donePeriods: bf.donePeriods,
  });

  log.info(
    `historico ${cursor.period}/${cursor.page}: ${matchIds.length} na lista, ${fresh.length} novas`,
  );

  await patch({
    lastPage: {
      period: cursor.period,
      page: cursor.page,
      found: matchIds.length,
      fresh: fresh.length,
      at: Date.now(),
    },
    queue: [...bf.queue, ...fresh],
    cursor: step.cursor,
    periods: step.periods,
    oldestPeriod: step.oldestPeriod,
    donePeriods: step.donePeriods,
    emptyMonths: step.emptyMonths,
    pagesDone: bf.pagesDone + 1,
    consecutiveFailures: 0,
  });

  if (step.cursor === null && fresh.length === 0) {
    const after = await getMeta();
    if (after.backfill.queue.length === 0) {
      await patch({ status: 'done' });
      log.info('backfill concluido');
    }
  }
}

/** Teto da lista de falhas guardada; acima disso as mais antigas caem. */
const MAX_FAILED = 500;

/** Anota (ou substitui) a falha de uma partida, para o "tentar de novo" das opcoes. */
async function markFailed(matchId: string, stage: string, reason: string): Promise<void> {
  const bf = (await getMeta()).backfill;
  const rest = (bf.failed ?? []).filter((f) => f.matchId !== matchId);
  await patch({ failed: [...rest, { matchId, stage, reason, at: Date.now() }].slice(-MAX_FAILED) });
}

async function collectOne(matchId: string, myGcId: number): Promise<void> {
  const bf = (await getMeta()).backfill;
  await patch({ queue: bf.queue.filter((id) => id !== matchId) });

  const path = matchApiPath(matchId);
  try {
    const parsed = parseMatchApi(await fetchJson(path), { myGcId, matchId, url: path });
    if (!parsed.ok) {
      // Partida de outra pessoa sai da fila sem contar como falha de leitura, mas
      // fica na lista: no historico do proprio usuario isso nao deveria acontecer.
      if (isSkip(parsed)) {
        log.debug('partida ignorada', matchId, parsed.reason);
        await markFailed(matchId, parsed.stage, parsed.reason);
        await patch({ consecutiveFailures: 0 });
        return;
      }
      await recordFailure({ url: path, at: Date.now(), reason: parsed.reason, stage: parsed.stage });
      await markFailed(matchId, parsed.stage, parsed.reason);
      await patch({ consecutiveFailures: (await getMeta()).backfill.consecutiveFailures + 1 });
      return;
    }
    await saveMatch(parsed.value, 'backfill');
    const now = await getMeta();
    await patch({
      matchesDone: now.backfill.matchesDone + 1,
      consecutiveFailures: 0,
      failed: (now.backfill.failed ?? []).filter((f) => f.matchId !== matchId),
    });
  } catch (err) {
    log.warn('falha ao coletar', matchId, err);
    await markFailed(matchId, 'fetch', err instanceof Error ? err.message : String(err));
    await patch({ consecutiveFailures: (await getMeta()).backfill.consecutiveFailures + 1 });
  }
}

/**
 * Reenfileira so as partidas que falharam. Diferente de "recomecar do zero", nao
 * rele nenhuma pagina do historico: uma requisicao por partida, no ritmo de sempre.
 */
export async function retryFailed(): Promise<number> {
  const bf = (await getMeta()).backfill;
  const queued = new Set(bf.queue);
  const ids = (bf.failed ?? []).map((f) => f.matchId).filter((id) => !queued.has(id));
  if (ids.length === 0) return 0;
  await patch({
    queue: [...bf.queue, ...ids],
    status: 'running',
    consecutiveFailures: 0,
    startedAt: bf.startedAt ?? Date.now(),
  });
  void resume();
  return ids.length;
}

/** Um passo de trabalho. Devolve false quando não há mais o que fazer agora. */
async function step(): Promise<boolean> {
  const meta = await getMeta();
  const bf = meta.backfill;

  if (bf.status !== 'running') return false;
  if (bf.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    await patch({ status: 'error' });
    log.warn('backfill parado apos falhas seguidas');
    return false;
  }
  if (meta.myGcId === null) {
    await patch({ status: 'paused' });
    log.warn('backfill pausado: defina seu id GC nas opcoes');
    return false;
  }

  // Espera so o que falta para completar o intervalo desde a ultima requisicao.
  // Antes dormia o intervalo inteiro a cada passo, inclusive no primeiro — o
  // backfill parecia travado por alguns segundos logo depois de ligar.
  const interval = Math.max(MIN_THROTTLE_MS, meta.throttleMs);
  const waitMs = lastRequestAt + interval - Date.now();
  if (waitMs > 0) await defaultSleep(waitMs);

  const [next] = bf.queue;
  if (next) {
    await collectOne(next, meta.myGcId);
    return true;
  }
  if (bf.cursor === null && bf.pagesDone > 0 && bf.periods.length === 0) {
    await patch({ status: 'done' });
    log.info('backfill concluido');
    return false;
  }
  await advance();
  return true;
}

/**
 * Retoma o laço. Chamado ao ligar o backfill e a cada alarme; o guarda `looping`
 * garante que nunca existam dois laços disparando requisições em paralelo.
 */
export async function resume(): Promise<void> {
  if (looping) return;
  looping = true;
  try {
    for (;;) {
      const keepGoing = await step();
      if (!keepGoing) return;
    }
  } catch (err) {
    log.error('laco do backfill morreu', err);
  } finally {
    looping = false;
  }
}

export const isRunning = (): boolean => looping;

/**
 * Descobre meu id GC pelo endpoint do usuario logado.
 * Sem id nao da para dizer "contra" ou "junto", e ate agora ele era digitado a mao.
 * Idempotente: nao refaz a requisicao se o id ja estiver definido, a menos que
 * `force` peca (botao das opcoes).
 */
export async function detectMyGcId(
  force = false,
): Promise<{ gcId: number | null; nick: string | null; level: number | null }> {
  const meta = await getMeta();
  if (meta.myGcId !== null && !force) {
    return { gcId: meta.myGcId, nick: meta.myNick ?? null, level: meta.myLevel ?? null };
  }

  try {
    const parsed = parseUserMe(await fetchJson(USER_ME_PATH));
    if (!parsed.ok) {
      log.warn('nao consegui ler meu id', parsed.stage, parsed.reason);
      return { gcId: meta.myGcId, nick: meta.myNick ?? null, level: meta.myLevel ?? null };
    }
    const { gcId, nick, level } = parsed.value;
    // Nick e nivel sao guardados sempre: e o que o card "meu perfil" mostra antes da
    // primeira partida gravada (e o que corrige um nick trocado depois).
    await updateMeta({ myGcId: gcId, myNick: nick, myLevel: level ?? meta.myLevel ?? null });
    if (gcId !== meta.myGcId) log.info('meu id GC detectado:', gcId, nick);
    return { gcId, nick, level };
  } catch (err) {
    // Deslogado ou offline: nao e erro de parser, so nao da para detectar agora.
    log.debug('deteccao de id falhou', err);
    return { gcId: meta.myGcId, nick: meta.myNick ?? null, level: meta.myLevel ?? null };
  }
}
