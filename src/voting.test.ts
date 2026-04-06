import { describe, it, expect } from 'vitest';
import { majorityVote, LEGACY_CONFUSION_GROUPS } from './solver.js';

describe('majorityVote', () => {
  it('picks the most common answer without confusion groups', () => {
    expect(majorityVote(['W287', 'W287', 'W287'])).toBe('W287');
  });

  it('does not merge 2→Z when confusion groups are disabled', () => {
    expect(majorityVote(['W287', 'W287', 'W2Z7'])).toBe('W287');
  });

  it('merges 2→Z with legacy confusion groups', () => {
    expect(majorityVote(['W287', 'W287', 'W287'], undefined, LEGACY_CONFUSION_GROUPS)).toBe(
      'WZ87'
    );
  });

  it('merges O/D/0 with legacy confusion groups', () => {
    expect(majorityVote(['O1RW', 'D1RW', '01RW'], undefined, LEGACY_CONFUSION_GROUPS)).toBe(
      'O1RW'
    );
  });

  it('does not merge O/D/0 without confusion groups', () => {
    // O appears once, D appears once, 0 appears once — ties broken by first seen
    const result = majorityVote(['O1RW', 'D1RW', 'O1RW']);
    expect(result).toBe('O1RW');
  });

  it('respects expectedLength filter', () => {
    expect(majorityVote(['AB', 'ABC', 'ABC', 'ABCD'], 3)).toBe('ABC');
  });

  it('falls back when expectedLength filters everything', () => {
    expect(majorityVote(['AB', 'CD'], 5)).toBe('AB');
  });

  it('returns empty string for empty input', () => {
    expect(majorityVote([])).toBe('');
  });

  it('character-level voting resolves per-position disagreement', () => {
    expect(majorityVote(['ABCD', 'AXCD', 'ABCD'])).toBe('ABCD');
  });

  it('confusionGroups: false is the same as no groups', () => {
    expect(majorityVote(['W287', 'W287', 'W287'], undefined, false)).toBe('W287');
  });
});
