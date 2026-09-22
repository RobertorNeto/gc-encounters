import { describe, expect, it } from 'vitest';
import { MIN_THROTTLE_MS } from '@/config/constants';
import { SequentialThrottle } from '@/lib/throttle';

/** Relógio falso: sleep só adianta o tempo, o teste não espera de verdade. */
function fakeClock() {
  let now = 0;
  const realNow = Date.now;
  Date.now = () => now;
  return {
    sleep: async (ms: number) => {
      now += ms;
    },
    get t() {
      return now;
    },
    restore: () => {
      Date.now = realNow;
    },
  };
}

describe('SequentialThrottle', () => {
  it('nunca aceita intervalo abaixo do piso da spec', () => {
    expect(new SequentialThrottle(0).intervalMs).toBe(MIN_THROTTLE_MS);
    expect(new SequentialThrottle(100).intervalMs).toBe(MIN_THROTTLE_MS);
    const t = new SequentialThrottle(9000);
    expect(t.intervalMs).toBe(9000);
    t.setInterval(10);
    expect(t.intervalMs).toBe(MIN_THROTTLE_MS);
  });

  it('roda sequencial, com o intervalo mínimo entre as execuções', async () => {
    const clock = fakeClock();
    try {
      const throttle = new SequentialThrottle(MIN_THROTTLE_MS);
      const starts: number[] = [];
      const running: number[] = [];
      let maxConcurrent = 0;

      const task = async () => {
        starts.push(clock.t);
        running.push(1);
        maxConcurrent = Math.max(maxConcurrent, running.length);
        running.pop();
        return starts.length;
      };

      await Promise.all([
        throttle.run(task, clock.sleep),
        throttle.run(task, clock.sleep),
        throttle.run(task, clock.sleep),
      ]);

      expect(maxConcurrent).toBe(1);
      expect(starts).toHaveLength(3);
      for (let i = 1; i < starts.length; i += 1) {
        expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(MIN_THROTTLE_MS);
      }
    } finally {
      clock.restore();
    }
  });

  it('uma task que falha não quebra a fila', async () => {
    const clock = fakeClock();
    try {
      const throttle = new SequentialThrottle(MIN_THROTTLE_MS);
      const boom = throttle.run(async () => {
        throw new Error('falhou');
      }, clock.sleep);
      await expect(boom).rejects.toThrow('falhou');
      await expect(throttle.run(async () => 'ok', clock.sleep)).resolves.toBe('ok');
    } finally {
      clock.restore();
    }
  });
});
