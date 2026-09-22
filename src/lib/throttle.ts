import { MIN_THROTTLE_MS } from '@/config/constants';

/**
 * Fila estritamente sequencial com intervalo minimo entre execucoes.
 * Regra inegociavel da spec: nunca paralelo, nunca abaixo de MIN_THROTTLE_MS.
 */
export class SequentialThrottle {
  #intervalMs: number;
  #lastRunAt = 0;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(intervalMs: number) {
    this.#intervalMs = this.#clamp(intervalMs);
  }

  #clamp(ms: number): number {
    return Math.max(MIN_THROTTLE_MS, Math.floor(ms) || MIN_THROTTLE_MS);
  }

  /** So aceita aumentar acima do piso; valores abaixo do piso sao elevados. */
  setInterval(ms: number): void {
    this.#intervalMs = this.#clamp(ms);
  }

  get intervalMs(): number {
    return this.#intervalMs;
  }

  run<T>(task: () => Promise<T>, sleep = defaultSleep): Promise<T> {
    const next = this.#chain.then(async () => {
      const waitFor = this.#lastRunAt + this.#intervalMs - Date.now();
      if (waitFor > 0) await sleep(waitFor);
      this.#lastRunAt = Date.now();
      return task();
    });
    // A corrente nunca pode quebrar por rejeicao de uma task.
    this.#chain = next.catch(() => undefined);
    return next;
  }
}

export const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
