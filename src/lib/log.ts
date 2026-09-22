// Regra da spec: falhar silenciosamente para o site, ruidosamente para o log interno.
// Nada daqui sai da maquina.
declare const __DEV__: boolean;

const PREFIX = '[gc-encounters]';
const isDev = typeof __DEV__ !== 'undefined' ? __DEV__ : false;

export const log = {
  debug(...args: unknown[]): void {
    if (isDev) console.debug(PREFIX, ...args);
  },
  info(...args: unknown[]): void {
    console.info(PREFIX, ...args);
  },
  warn(...args: unknown[]): void {
    console.warn(PREFIX, ...args);
  },
  error(...args: unknown[]): void {
    console.error(PREFIX, ...args);
  },
};

/**
 * Executa `fn` sem nunca deixar excecao escapar para a pagina da GC.
 * Content scripts compartilham o contexto de erro da aba — uma excecao nossa
 * nao pode aparecer como erro do site nem interromper handlers do proprio site.
 */
export async function guard<T>(stage: string, fn: () => Promise<T> | T): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    log.error(`falha em ${stage}:`, err);
    return null;
  }
}
