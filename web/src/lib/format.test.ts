import { describe, expect, it } from 'vitest';
import { compileFilter, flattenConfig, fmtNum, groupKeys, naturalCompare, toDate } from './format';

describe('naturalCompare', () => {
  it('orders numbers numerically', () => {
    const keys = ['layer10/a', 'layer2/a', 'layer1/b', 'eval/acc', 'layer1/a'];
    expect(keys.sort(naturalCompare)).toEqual(['eval/acc', 'layer1/a', 'layer1/b', 'layer2/a', 'layer10/a']);
  });
});

describe('groupKeys', () => {
  it('groups by first prefix, ungrouped first', () => {
    const g = groupKeys(['train/loss', 'lr', 'eval/acc', 'train/a/b', 'epoch']);
    expect(g.map((x) => x.name)).toEqual(['', 'eval', 'train']);
    expect(g[0].keys).toEqual(['lr', 'epoch']);
    expect(g[2].keys).toEqual(['train/loss', 'train/a/b']);
  });
});

describe('compileFilter', () => {
  it('supports plain, regex and invalid patterns', () => {
    expect(compileFilter('LOSS').test('train/loss')).toBe(true);
    expect(compileFilter('/^eval/').test('train/eval')).toBe(false);
    expect(compileFilter('layer(1|2)/').test('layer2/x')).toBe(true);
    const bad = compileFilter('loss[');
    expect(bad.error).toBeTruthy();
    expect(bad.test('train/loss[0]')).toBe(true);
    expect(compileFilter('').test('x')).toBe(true);
  });
});

describe('misc', () => {
  it('toDate handles iso, seconds and ms', () => {
    expect(toDate('2024-01-01T00:00:00Z')!.getTime()).toBe(Date.UTC(2024, 0, 1));
    expect(toDate(1704067200)!.getTime()).toBe(Date.UTC(2024, 0, 1));
    expect(toDate(1704067200000)!.getTime()).toBe(Date.UTC(2024, 0, 1));
    expect(toDate(null)).toBeNull();
  });
  it('flattenConfig', () => {
    expect(flattenConfig({ a: 1, m: { d: 2, e: { f: 'x' } }, l: [1] })).toEqual({ a: 1, 'm.d': 2, 'm.e.f': 'x', l: [1] });
  });
  it('fmtNum', () => {
    expect(fmtNum(null)).toBe('—');
    expect(fmtNum(0.000012)).toBe('1.20e-5');
    expect(fmtNum(2.345678)).toBe('2.346');
    expect(fmtNum(42)).toBe('42');
  });
});
