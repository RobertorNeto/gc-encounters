import { describe, expect, it } from 'vitest';
import { makeCursor, nextCursor, parseCursor, previousMonth } from '@/background/backfill';
import type { BackfillState } from '@/types';

const state = (over: Partial<BackfillState> = {}): Pick<
  BackfillState,
  'periods' | 'oldestPeriod' | 'emptyMonths' | 'donePeriods'
> => ({ periods: [], oldestPeriod: null, emptyMonths: 0, donePeriods: [], ...over });

describe('cursor', () => {
  it('serializa e volta', () => {
    expect(parseCursor(makeCursor('2026-09', 3))).toEqual({ period: '2026-09', page: 3 });
    expect(parseCursor(null)).toEqual({ period: 'latest', page: 1 });
    expect(parseCursor('lixo')).toEqual({ period: 'latest', page: 1 });
  });
});

describe('previousMonth', () => {
  it('anda para trás, inclusive virando o ano', () => {
    expect(previousMonth('2024-01')).toBe('2023-12');
    expect(previousMonth('2026-09')).toBe('2026-08');
    expect(previousMonth('2026-10')).toBe('2026-09');
  });

  it('recusa formato inválido em vez de chutar', () => {
    expect(previousMonth('latest')).toBeNull();
    expect(previousMonth('2024-13')).toBeNull();
  });
});

describe('nextCursor', () => {
  it('esgota as páginas do mês antes de trocar de mês', () => {
    const step = nextCursor({ period: '2026-09', page: 1 }, 10, 3, state());
    expect(step.cursor).toBe('2026-09/2');
  });

  it('depois da última página, vai para o próximo mês da lista da GC', () => {
    const step = nextCursor(
      { period: '2026-09', page: 3 },
      10,
      3,
      state({ periods: ['2026-08', '2026-07'] }),
    );
    expect(step.cursor).toBe('2026-08/1');
    expect(step.periods).toEqual(['2026-07']);
  });

  it('acabou a lista da GC: caminha para trás a partir do mês mais antigo visto', () => {
    const step = nextCursor({ period: '2024-03', page: 1 }, 7, 1, state({ oldestPeriod: '2024-03' }));
    expect(step.cursor).toBe('2024-02/1');
    expect(step.oldestPeriod).toBe('2024-02');
  });

  it('mês vazio conta para a parada; mês com partida zera a contagem', () => {
    const vazio = nextCursor({ period: '2024-02', page: 1 }, 0, 1, state({ oldestPeriod: '2024-02', emptyMonths: 2 }));
    expect(vazio.emptyMonths).toBe(3);

    const cheio = nextCursor({ period: '2024-02', page: 1 }, 5, 1, state({ oldestPeriod: '2024-02', emptyMonths: 2 }));
    expect(cheio.emptyMonths).toBe(0);
  });

  it('para depois de 6 meses seguidos vazios', () => {
    const step = nextCursor({ period: '2019-01', page: 1 }, 0, 1, state({ oldestPeriod: '2019-01', emptyMonths: 5 }));
    expect(step.emptyMonths).toBe(6);
    expect(step.cursor).toBeNull();
  });

  it('para no piso de 2015 mesmo sem meses vazios', () => {
    const step = nextCursor({ period: '2015-01', page: 1 }, 3, 1, state({ oldestPeriod: '2015-01' }));
    expect(step.cursor).toBeNull();
  });

  it('a página "latest" não mexe no controle de meses vazios', () => {
    const step = nextCursor({ period: 'latest', page: 1 }, 0, 1, state({ periods: ['2026-09'], emptyMonths: 4 }));
    expect(step.emptyMonths).toBe(4);
    expect(step.cursor).toBe('2026-09/1');
    expect(step.oldestPeriod).toBeNull();
  });

  it('atravessa a virada de ano indo para trás', () => {
    const step = nextCursor({ period: '2024-01', page: 1 }, 4, 1, state({ oldestPeriod: '2024-01' }));
    expect(step.cursor).toBe('2023-12/1');
  });
});

describe('não repete mês já visitado', () => {
  it('descarta meses da lista que já ficaram para trás', () => {
    // Ja passei por 2026-05; a lista ainda traz meses mais novos que isso.
    const step = nextCursor(
      { period: '2026-05', page: 1 },
      8,
      1,
      state({ periods: ['2026-07', '2026-06', '2026-04'], oldestPeriod: '2026-05' }),
    );
    expect(step.cursor).toBe('2026-04/1');
    expect(step.periods).toEqual([]);
  });

  it('a lista inteira já visitada cai na caminhada para trás', () => {
    const step = nextCursor(
      { period: '2024-03', page: 1 },
      5,
      1,
      state({ periods: ['2026-09', '2025-01'], oldestPeriod: '2024-03' }),
    );
    expect(step.cursor).toBe('2024-02/1');
  });

  it('mês mais antigo que o visitado continua valendo', () => {
    const step = nextCursor(
      { period: '2026-05', page: 1 },
      8,
      1,
      state({ periods: ['2026-03'], oldestPeriod: '2026-05' }),
    );
    expect(step.cursor).toBe('2026-03/1');
  });
});

describe('meses já varridos', () => {
  it('marca o mês como concluído ao terminar a última página', () => {
    const step = nextCursor({ period: '2026-09', page: 2 }, 4, 2, state({ oldestPeriod: '2026-09' }));
    expect(step.donePeriods).toEqual(['2026-09']);
  });

  it('não marca enquanto ainda há páginas no mês', () => {
    const step = nextCursor({ period: '2026-09', page: 1 }, 10, 3, state());
    expect(step.donePeriods).toEqual([]);
  });

  it('"latest" nunca entra na lista: não é um mês', () => {
    const step = nextCursor({ period: 'latest', page: 4 }, 1, 4, state({ periods: ['2026-09'] }));
    expect(step.donePeriods).toEqual([]);
  });

  it('pula meses da lista que já foram varridos antes', () => {
    const step = nextCursor(
      { period: 'latest', page: 1 },
      5,
      1,
      state({ periods: ['2026-09', '2026-08', '2026-07'], donePeriods: ['2026-09', '2026-08'] }),
    );
    expect(step.cursor).toBe('2026-07/1');
  });

  it('a caminhada para trás salta meses já varridos', () => {
    const step = nextCursor(
      { period: '2024-06', page: 1 },
      3,
      1,
      state({ oldestPeriod: '2024-06', donePeriods: ['2024-05', '2024-04'] }),
    );
    expect(step.cursor).toBe('2024-03/1');
  });

  it('não duplica um mês já presente na lista', () => {
    const step = nextCursor(
      { period: '2026-09', page: 1 },
      4,
      1,
      state({ donePeriods: ['2026-09'], oldestPeriod: '2026-09' }),
    );
    expect(step.donePeriods).toEqual(['2026-09']);
  });
});
