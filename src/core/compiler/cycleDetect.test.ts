import { describe, expect, it } from 'vitest';
import { detectCycle } from './cycleDetect';
import { makeStep } from '@/src/test/fixtures';

describe('detectCycle', () => {
  it('无环：线性链', () => {
    const result = detectCycle([
      makeStep({ id: 'a' }),
      makeStep({ id: 'b', dependsOn: ['a'] }),
      makeStep({ id: 'c', dependsOn: ['b'] }),
    ]);
    expect(result.hasCycle).toBe(false);
    expect(result.cycle).toEqual([]);
  });

  it('无环：菱形依赖', () => {
    const result = detectCycle([
      makeStep({ id: 'a' }),
      makeStep({ id: 'b', dependsOn: ['a'] }),
      makeStep({ id: 'c', dependsOn: ['a'] }),
      makeStep({ id: 'd', dependsOn: ['b', 'c'] }),
    ]);
    expect(result.hasCycle).toBe(false);
  });

  it('有环：a → b → c → a，且给出环路径', () => {
    const result = detectCycle([
      makeStep({ id: 'a', dependsOn: ['c'] }),
      makeStep({ id: 'b', dependsOn: ['a'] }),
      makeStep({ id: 'c', dependsOn: ['b'] }),
    ]);
    expect(result.hasCycle).toBe(true);
    expect(result.cycle.length).toBeGreaterThanOrEqual(3);
    expect(new Set(result.cycle)).toEqual(new Set(['a', 'b', 'c']));
  });

  it('有环：自环', () => {
    const result = detectCycle([makeStep({ id: 'a', dependsOn: ['a'] })]);
    expect(result.hasCycle).toBe(true);
  });

  it('指向不存在节点的依赖不算环', () => {
    const result = detectCycle([makeStep({ id: 'a', dependsOn: ['ghost'] })]);
    expect(result.hasCycle).toBe(false);
  });
});
