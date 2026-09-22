export type Result<T> = { ok: true; value: T } | { ok: false; reason: string; stage: string };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = (stage: string, reason: string): Result<never> => ({
  ok: false,
  reason,
  stage,
});

/**
 * Prefixo de estagio para "nao e caso de gravar", em oposicao a "quebrou".
 * Partida de outra pessoa (link de convite, perfil alheio) nao e erro de parser:
 * nao vira registro, nao vira alerta e nao conta falha no backfill.
 */
export const SKIP = 'skip:';
export const isSkip = (r: Result<unknown>): boolean => !r.ok && r.stage.startsWith(SKIP);
