export type PlayerId = number; // id da GC, chave estavel (nick muda, id nao)
export type MatchId = string;
export type Team = 'A' | 'B';
export type MatchSource = 'live' | 'backfill';
/** Resultado da partida do MEU ponto de vista. `null` quando o placar nao da para ler. */
export type Outcome = 'win' | 'loss' | 'draw';

export interface NickSighting {
  nick: string;
  seenAt: number;
}

export interface Player {
  gcId: PlayerId;
  nick: string;
  nickHistory: NickSighting[];
  lastLevel: number | null;
  firstSeen: number;
  lastSeen: number;
  note?: string;
  /** Contadores desnormalizados — mantidos por saveMatch, usados por getEncounters. */
  totalMatches: number;
  totalAgainst: number;
  totalTogether: number;
  totalWins: number;
  totalLosses: number;
  totalDraws: number;
  lastPlayedAt: number;
  lastMatchId: MatchId | null;
  /** Soma de kills/deaths nas partidas com K/D gravado; `kdRows` diz em quantas. */
  totalKills?: number;
  totalDeaths?: number;
  kdRows?: number;
  /** MEU resultado separado por relacao: no mesmo time vs. em times opostos. */
  togetherWins?: number;
  togetherLosses?: number;
  togetherDraws?: number;
  againstWins?: number;
  againstLosses?: number;
  againstDraws?: number;
}

export interface Match {
  matchId: MatchId;
  playedAt: number;
  map: string | null;
  /** Placar no formato "13-8": time A primeiro, time B depois. */
  score: string | null;
  /** Vitoria/derrota MINHA, derivada do placar + o time em que eu joguei. */
  result: Outcome | null;
  source: MatchSource;
  collectedAt: number;
}

export type Relation = 'me' | 'together' | 'against';

export interface MatchPlayer {
  matchId: MatchId;
  gcId: PlayerId;
  team: Team;
  levelAtMatch: number | null;
  wasMe: boolean;
  /** Desnormalizado: posicao relativa a mim nessa partida. Evita join com matches. */
  relation: Relation;
  /** Desnormalizado: copia de match.playedAt, para ordenar sem join. */
  playedAt: number;
  /** Desnormalizado: meu resultado nessa partida, para contar V/D sem join. */
  result: Outcome | null;
  /** Kills/deaths do jogador nessa partida. Ausentes em registros coletados antes do campo existir. */
  kills?: number | null;
  deaths?: number | null;
}

export interface BackfillState {
  status: 'idle' | 'running' | 'paused' | 'done' | 'error';
  cursor: string | null;
  pagesDone: number;
  matchesDone: number;
  consecutiveFailures: number;
  startedAt: number | null;
  updatedAt: number | null;
  /** Fila de matchIds descobertos e ainda nao coletados. */
  queue: MatchId[];
  /** Meses ainda por visitar ("2026-09"), do mais recente ao mais antigo. */
  periods: string[];
  /** Mes mais antigo ja visitado, ponto de partida da varredura para tras. */
  oldestPeriod: string | null;
  /**
   * Meses ja varridos por completo. Sobrevive ao "Zerar progresso" de proposito:
   * progresso e descartavel, mas refazer mes ja lido e requisicao jogada fora.
   */
  donePeriods: string[];
  /** Meses seguidos sem nenhuma partida — criterio de parada do passeio para tras. */
  emptyMonths: number;
  /** Diagnostico da ultima pagina lida: mes vazio de verdade ou leitura errada? */
  lastPage: { period: string; page: number; found: number; fresh: number; at: number } | null;
  /**
   * Partidas que sairam da fila sem virar registro (parser reprovou, HTTP falhou,
   * ou foram ignoradas por eu nao estar no elenco). E o que permite "tentar de novo"
   * so nelas, em vez de varrer o historico inteiro outra vez.
   */
  failed?: FailedMatch[];
}

export interface FailedMatch {
  matchId: MatchId;
  stage: string;
  reason: string;
  at: number;
}

export interface ParseFailure {
  url: string;
  at: number;
  reason: string;
  stage: string;
}

export interface Meta {
  key: 'meta';
  myGcId: PlayerId | null;
  /**
   * Nick e nivel vindos da deteccao pela sessao (`/api/v1/user/me`). Servem para o
   * card "meu perfil" antes da primeira partida gravada; depois a linha em
   * `players` (atualizada a cada partida) tem prioridade.
   */
  myNick?: string | null;
  myLevel?: number | null;
  schemaVersion: number;
  backfill: BackfillState;
  lastFailure: ParseFailure | null;
  throttleMs: number;
  /** Quando os resultados (V/D) foram preenchidos nos registros antigos. */
  resultsRepairedAt: number | null;
}

/**
 * Saida do parser. Unidade atomica de escrita.
 * `result` e opcional: o parser pode deixar para o repositorio derivar do placar.
 */
export interface MatchRecord {
  match: Omit<Match, 'source' | 'collectedAt' | 'result'> & { result?: Outcome | null };
  players: {
    gcId: PlayerId;
    nick: string;
    team: Team;
    level: number | null;
    wasMe: boolean;
    /** Opcionais: a fonte pode nao trazer. Nunca inventados. */
    kills?: number | null;
    deaths?: number | null;
  }[];
}

export interface Encounter {
  gcId: PlayerId;
  nick: string;
  lastLevel: number | null;
  total: number;
  against: number;
  together: number;
  /** Nas partidas em comum com esse jogador: quantas EU venci/perdi/empatei. */
  wins: number;
  losses: number;
  draws: number;
  /** Partidas com resultado conhecido (base do percentual). */
  decided: number;
  /** K/D acumulado do jogador nas partidas em comum que trouxeram o dado (`kdRows`). */
  kills: number;
  deaths: number;
  kdRows: number;
  /** MEU resultado quando jogamos no mesmo time / em times opostos. */
  togetherWins: number;
  togetherLosses: number;
  togetherDraws: number;
  againstWins: number;
  againstLosses: number;
  againstDraws: number;
  lastPlayedAt: number;
  lastMatchId: MatchId | null;
  note?: string;
}
