/**
 * Contrato de mensagens entre content scripts, página de opções e service worker.
 *
 * Por que existe: o IndexedDB visto por um content script é o da ORIGEM DA PÁGINA
 * (gamersclub.com.br), não o da extensão. Gravar lá deixaria o histórico exposto ao
 * site e sujeito a limpeza de dados dele. Então o banco vive só no service worker /
 * página de opções, e as páginas conversam com ele por mensagem.
 */
import type { DbDump, DbStats, SharedMatch } from '@/db/repo';
import type { Encounter, MatchRecord, MatchSource, Meta, ParseFailure, PlayerId } from '@/types';

export type Msg =
  | { type: 'ping' }
  | { type: 'saveMatch'; record: MatchRecord; source: MatchSource }
  | { type: 'getEncounters'; gcIds: PlayerId[] }
  | { type: 'getSharedMatches'; gcId: PlayerId; limit?: number }
  | { type: 'setNote'; gcId: PlayerId; note: string }
  | { type: 'reportFailure'; failure: ParseFailure }
  | { type: 'setMyGcId'; gcId: PlayerId }
  | { type: 'getMeta' }
  | { type: 'setThrottle'; ms: number }
  | { type: 'getStats' }
  | { type: 'getTop'; limit?: number }
  | { type: 'search'; query: string }
  | { type: 'export' }
  | { type: 'import'; dump: DbDump }
  | { type: 'wipe' }
  | { type: 'repairResults' }
  | { type: 'detectMyId' }
  /** A aba so sugere partidas; cursor e meses pertencem ao motor no worker. */
  | { type: 'backfill:enqueue'; matchIds: string[]; periods?: string[] }
  | { type: 'backfill:next' }
  | { type: 'backfill:takePeriod' }
  | {
      type: 'backfill:result';
      matchId: string;
      okResult: boolean;
      reason?: string;
      /** Coletada com sucesso mas nao gravada (nao e minha partida). */
      skipped?: boolean;
    }
  | {
      type: 'backfill:control';
      /** `retryFailed`: reenfileira so as partidas que falharam na leitura. */
      action: 'start' | 'pause' | 'reset' | 'finishPage' | 'retryFailed';
    };

export interface BackfillJob {
  matchId: string;
  waitMs: number;
}

export type MsgResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

/** Envia ao worker e desembrulha o resultado. Nunca joga exceção na página. */
export async function send<T>(msg: Msg): Promise<T | null> {
  try {
    const res = (await chrome.runtime.sendMessage(msg)) as MsgResult | undefined;
    if (!res) return null;
    if (!res.ok) {
      console.warn('[gc-encounters] worker recusou', msg.type, res.error);
      return null;
    }
    return res.value as T;
  } catch (err) {
    // Worker reiniciando ou extensão recarregada: a página segue intacta.
    console.debug('[gc-encounters] mensagem falhou', msg.type, err);
    return null;
  }
}

/** Encounters trafegam como array porque Map não sobrevive à serialização. */
export type EncounterList = Encounter[];
export type { DbDump, DbStats, SharedMatch, Meta };
