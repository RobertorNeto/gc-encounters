/** Piso do throttle do backfill. Spec: minimo 2500 ms, configuravel so para cima. */
export const MIN_THROTTLE_MS = 2500;
export const DEFAULT_THROTTLE_MS = 3000;

/** Backfill para sozinho apos 3 falhas seguidas. */
export const MAX_CONSECUTIVE_FAILURES = 3;

export const DB_NAME = 'gc-encounters';
export const DB_VERSION = 1;

/** Unicos hosts que a extensao pode tocar. Zero rede externa. */
export const ALLOWED_HOSTS = ['gamersclub.com.br', 'cs.gamersclub.gg'] as const;

export function isAllowedUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== 'https:') return false;
    return ALLOWED_HOSTS.some((h) => hostname === h || hostname.endsWith(`.${h}`));
  } catch {
    return false;
  }
}
