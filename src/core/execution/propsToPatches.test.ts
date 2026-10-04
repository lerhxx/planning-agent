/**
 * `propsToPatches` 的**严格** RFC 6902 验证（CopilotKit v2 / AG-UI 侧的行为口径）。
 *
 * ★ 为什么单独写这个文件，而且必须自带一个严格 applier：
 *   曾经 424 个测试全绿、HTTP 也 200，但澄清卡片一条 props 都打不上去 —— 因为
 *   验证用的是旧前端 `src/features/run/nodeReducer.ts` 的 `applyPatch`，它是**宽容**的
 *   （父节点缺失时自动创建、对象成员上 `add`/`replace` 同义），坏补丁会被它"自愈"，
 *   于是测试假绿。CopilotKit v2 用严格 RFC 6902，同一批补丁全失败。
 *   所以这里**故意不用** `nodeReducer.applyPatch`，自己实现一份严格版本。
 *
 * ★ 本文件里的 `StrictApplier` 只在测试中使用：它保证"真的严格"的方式是 ——
 *   `replace` 目标不存在 / `add /a/-` 而 `/a` 不存在 / 越界写入，一律抛错，
 *   并且下面专门有用例断言**旧的那两种坏补丁确实会被它拒绝**（第 5、6 例）。
 *   一个连已知坏补丁都能通过的 applier，等于没验。
 */
import { describe, expect, it } from 'vitest';
import type { JsonPatchOperation } from '@/shared/stream/events';
import { propsToPatches } from './executor';

type Container = Record<string, unknown> | unknown[];

function isArrayIndex(token: string): boolean {
  return /^(0|[1-9]\d*)$/.test(token);
}

/** 解析 `-`（追加）以外的数组下标。 */
function arrayIndex(token: string): number {
  return Number(token);
}

function splitPath(path: string): string[] {
  if (path.length === 0 || path[0] !== '/') {
    throw new Error(`非法 JSON Pointer：${path}（必须以 / 开头）`);
  }
  // 只需支持本仓库用到的 token；`~1` / `~0` 转义按 RFC 6901 还原。
  return path
    .slice(1)
    .split('/')
    .map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/** 沿 parents 下钻，任何一层不存在就直接抛错 —— 不做自动创建（严格的关键）。 */
function resolveParent(document: Container, parents: string[]): Container {
  let cursor: Container = document;
  for (const token of parents) {
    if (Array.isArray(cursor)) {
      if (!isArrayIndex(token)) {
        throw new Error(`数组下标非法：/${token}`);
      }
      const index = arrayIndex(token);
      if (index >= cursor.length) {
        throw new Error(`Cannot perform the operation at a path that does not exist：/${token}`);
      }
      const child = cursor[index];
      if (child === null || typeof child !== 'object') {
        throw new Error(`Cannot perform the operation at a path that does not exist：/${token}`);
      }
      cursor = child as Container;
      continue;
    }
    const child = cursor[token];
    if (child === null || typeof child !== 'object' || !(token in cursor)) {
      throw new Error(`Cannot perform the operation at a path that does not exist：/${token}`);
    }
    cursor = child as Container;
  }
  return cursor;
}

/** 严格 RFC 6902 应用一条补丁到**原对象**（原地修改，模拟消费端持有同一份文档）。 */
function applyStrict(document: Container, operation: JsonPatchOperation): void {
  const tokens = splitPath(operation.path);
  if (tokens.length === 0) {
    throw new Error('不允许对文档根做整替换');
  }
  const parents = tokens.slice(0, -1);
  const last = tokens[tokens.length - 1];
  const target = resolveParent(document, parents);

  if (Array.isArray(target)) {
    if (operation.op === 'add') {
      if (last === '-') {
        target.push(operation.value);
        return;
      }
      if (!isArrayIndex(last)) throw new Error(`数组下标非法：/${last}`);
      const index = arrayIndex(last);
      if (index > target.length) {
        throw new Error(`Cannot perform the operation at a path that does not exist：/${last}`);
      }
      target.splice(index, 0, operation.value);
      return;
    }
    if (!isArrayIndex(last)) throw new Error(`数组下标非法：/${last}`);
    const index = arrayIndex(last);
    if (index >= target.length) {
      throw new Error(`Cannot perform the operation at a path that does not exist：/${last}`);
    }
    if (operation.op === 'replace') {
      target[index] = operation.value;
      return;
    }
    target.splice(index, 1);
    return;
  }

  if (operation.op === 'add') {
    target[last] = operation.value;
    return;
  }
  if (!(last in target)) {
    throw new Error(`Cannot perform the operation at a path that does not exist：/${last}`);
  }
  if (operation.op === 'replace') {
    target[last] = operation.value;
    return;
  }
  delete target[last];
}

/** 从 `{}` 开始按顺序应用全部补丁，返回最终文档。任何一条不合法即抛错。 */
function applyAllStrict(operations: JsonPatchOperation[]): Record<string, unknown> {
  const document: Record<string, unknown> = {};
  for (const operation of operations) applyStrict(document, operation);
  return document;
}

describe('propsToPatches（严格 RFC 6902 视角）', () => {
  it('★ 标量 + 数组混合：从 {} 起逐个 apply，结果深等于原 props', () => {
    const props: Record<string, unknown> = {
      questionId: 'clarify:trip.budget',
      prompt: '这次出行的人均预算大概是多少？',
      multi: false,
      fields: [
        { id: 'days', kind: 'number', label: '几天', required: true },
        { id: 'budget', kind: 'text', label: '预算' },
      ],
      options: [],
    };

    const operations = propsToPatches(props);
    expect(operations.length).toBeGreaterThan(0);
    expect(applyAllStrict(operations)).toEqual(props);
  });

  it('★ 数组字段先建父节点：fields 长度正确，空 options 也存在且为 []', () => {
    const props: Record<string, unknown> = {
      fields: [{ id: 'a' }, { id: 'b' }],
      options: [],
    };
    const operations = propsToPatches(props);

    // 建父节点那一条必须存在（否则 `add /fields/-` 在严格实现下必然失败）。
    expect(operations).toContainEqual({ op: 'add', path: '/fields', value: [] });
    expect(operations).toContainEqual({ op: 'add', path: '/options', value: [] });

    const applied = applyAllStrict(operations);
    expect(applied['fields']).toHaveLength(2);
    expect(applied['options']).toEqual([]);
    expect(applied).toEqual(props);
  });

  it('★ component_end 的 /status 在 {} 上能 apply', () => {
    const applied = applyAllStrict([{ op: 'add', path: '/status', value: 'ready' }]);
    expect(applied['status']).toBe('ready');
  });

  it('undefined 值的键不产出补丁（避免把 undefined 写进文档）', () => {
    const operations = propsToPatches({ title: 'T', missing: undefined });
    expect(operations).toEqual([{ op: 'add', path: '/title', value: 'T' }]);
    expect(applyAllStrict(operations)).toEqual({ title: 'T' });
  });

  it('★ 反向锁：严格 applier 确实会拒绝「replace 打在 {} 上」（旧 bug 形态一）', () => {
    expect(() => applyAllStrict([{ op: 'replace', path: '/title', value: 'T' }])).toThrow(
      /does not exist/,
    );
  });

  it('★ 反向锁：严格 applier 确实会拒绝「add /fields/- 而 /fields 不存在」（旧 bug 形态二）', () => {
    expect(() =>
      applyAllStrict([{ op: 'add', path: '/fields/-', value: { id: 'a' } }]),
    ).toThrow(/does not exist/);
  });

  it('★ JSON Pointer 转义：键含 / 或 ~ 时仍是单层键，且严格 apply 后深等于原 props', () => {
    const props: Record<string, unknown> = {
      'a/b': 1,
      'c~d': 2,
      'e/f': [{ id: 'x' }],
    };

    const operations = propsToPatches(props);
    // 路径按 RFC 6901 转义：`/`→`~1`、`~`→`~0`，且顺序正确（不出现 `~01`）。
    expect(operations.map((operation) => operation.path)).toEqual([
      '/a~1b',
      '/c~0d',
      '/e~1f',
      '/e~1f/-',
    ]);

    const applied = applyAllStrict(operations);
    expect(applied).toEqual(props);
    // 关键是"单层"：绝不能被当成层级分隔符塞进嵌套对象里。
    expect(applied['a/b']).toBe(1);
    expect(applied['c~d']).toBe(2);
    expect(applied['e/f']).toEqual([{ id: 'x' }]);
    expect(applied['a']).toBeUndefined();
    expect(applied['c']).toBeUndefined();
    expect(applied['e']).toBeUndefined();
  });

  it('★ 反向锁：不转义的旧形态在严格 applier 下失败（去掉 escapeToken 就会红）', () => {
    // 旧实现会产出 `/a/b`，严格实现下父节点 `/a` 不存在 → 抛错。
    expect(() => applyAllStrict([{ op: 'add', path: '/a/b', value: 1 }])).toThrow(
      /does not exist/,
    );
  });

  it('增量而非整包：条数守恒、不整包重发、且每个数组的父节点先于其元素', () => {
    const operations = propsToPatches({ a: 1, b: [1, 2, 3], c: [] });
    // a → 1 条；b → 1 条建父 + 3 条元素；c → 1 条建父
    expect(operations).toHaveLength(1 + 4 + 1);

    // 红线 7：绝不整包重发 —— 没有任何一条写文档根。
    expect(operations.every((operation) => operation.path.length > 1)).toBe(true);

    // 每个数组的建父节点必须排在自己的元素之前（严格实现下顺序反了就打不上）。
    for (const key of ['b', 'c']) {
      const parentAt = operations.findIndex(
        (operation) => operation.path === `/${key}` && Array.isArray(operation.value),
      );
      const firstItemAt = operations.findIndex((operation) => operation.path === `/${key}/-`);
      expect(parentAt).toBeGreaterThanOrEqual(0);
      if (firstItemAt >= 0) expect(parentAt).toBeLessThan(firstItemAt);
    }
  });
});
