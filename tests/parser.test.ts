/**
 * Testes do parser.
 *
 * Spec §8: os testes de extração rodam sobre FIXTURES REAIS salvos em tests/fixtures/,
 * nunca sobre HTML inventado. Enquanto a Fase 0 não for feita não há fixture, e o
 * bloco de extração fica declaradamente pendente (`it.skip`) em vez de fingir cobertura.
 *
 * Como popular: rode tools/recon-capture.js no DevTools da página e salve o .html aqui.
 * Nomeie `match-*.html` (página de partida) e `my-matches-*.html` (histórico).
 * Para cada fixture, um `.expected.json` ao lado com o MatchRecord esperado.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractMatchId, extractPlayerId, parseGcDate, parseMatchDom, parseMyMatchesDom } from '@/content/shared/parser';
import type { MatchRecord } from '@/types';

const DIR = join(__dirname, 'fixtures');
const files = existsSync(DIR) ? readdirSync(DIR) : [];
const matchFixtures = files.filter((f) => f.startsWith('match-') && f.endsWith('.html'));
const listFixtures = files.filter((f) => f.startsWith('my-matches-') && f.endsWith('.html'));

const doc = (html: string): Document =>
  new DOMParser().parseFromString(html, 'text/html');

describe('extração de ids (independente de layout)', () => {
  it('lê o id do jogador do href do perfil', () => {
    expect(extractPlayerId('/jogador/123456')).toBe(123456);
    expect(extractPlayerId('https://gamersclub.com.br/player/98765?tab=stats')).toBe(98765);
    expect(extractPlayerId('/lobby')).toBeNull();
    expect(extractPlayerId(null)).toBeNull();
  });

  it('lê o id da partida do href', () => {
    expect(extractMatchId('/partida/8899')).toBe('8899');
    expect(extractMatchId('https://gamersclub.com.br/match/ab-12')).toBe('ab-12');
    expect(extractMatchId('/minhas-partidas')).toBeNull();
  });
});

describe('datas', () => {
  it('aceita ISO', () => {
    expect(parseGcDate('2025-09-12T20:30:00.000Z')).toBe(Date.parse('2025-09-12T20:30:00.000Z'));
  });

  it('aceita dd/mm/yyyy hh:mm no fuso local', () => {
    expect(parseGcDate('12/09/2025 20:30')).toBe(new Date(2025, 8, 12, 20, 30).getTime());
    expect(parseGcDate('12/09/2025')).toBe(new Date(2025, 8, 12, 0, 0).getTime());
  });

  it('devolve null em vez de chutar', () => {
    expect(parseGcDate('ontem')).toBeNull();
    expect(parseGcDate(null)).toBeNull();
  });
});

const describeMatch = matchFixtures.length ? describe : describe.skip;
describeMatch('página de partida (fixtures reais)', () => {
  for (const file of matchFixtures) {
    it(`extrai ${file} exatamente como o esperado`, () => {
      const html = readFileSync(join(DIR, file), 'utf8');
      const expectedPath = join(DIR, file.replace(/\.html$/, '.expected.json'));
      const expected = JSON.parse(readFileSync(expectedPath, 'utf8')) as MatchRecord & {
        myGcId: number;
      };

      const res = parseMatchDom(doc(html), { myGcId: expected.myGcId, matchId: expected.match.matchId });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.match).toEqual(expected.match);
      expect([...res.value.players].sort((a, b) => a.gcId - b.gcId)).toEqual(
        [...expected.players].sort((a, b) => a.gcId - b.gcId),
      );
    });

    it(`reprova ${file} quando meu id não está na partida`, () => {
      const html = readFileSync(join(DIR, file), 'utf8');
      const res = parseMatchDom(doc(html), { myGcId: -1 });
      expect(res.ok).toBe(false);
    });
  }
});

const describeList = listFixtures.length ? describe : describe.skip;
describeList('histórico (fixtures reais)', () => {
  for (const file of listFixtures) {
    it(`lista matchIds de ${file}`, () => {
      const html = readFileSync(join(DIR, file), 'utf8');
      const res = parseMyMatchesDom(doc(html), 'https://gamersclub.com.br/minhas-partidas');
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.matchIds.length).toBeGreaterThan(0);
      expect(new Set(res.value.matchIds).size).toBe(res.value.matchIds.length);
    });
  }
});

if (matchFixtures.length === 0) {
  describe('fixtures', () => {
    it.skip('Fase 0 pendente: nenhum fixture real em tests/fixtures/ (ver RECON.md)', () => {});
  });
}
