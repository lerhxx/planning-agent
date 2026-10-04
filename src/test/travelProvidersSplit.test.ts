/**
 * `providers/` 拆分后的结构守卫 + K12 回归锁（设计 §5 / §9 T03）。
 *
 * 三条守卫：
 * 1. **桶的行为没变**：`createTripProviders()` 的 namespace / `create()` / `createValidator()` 与拆分前一致；
 * 2. **依赖方向只能从上往下**（设计 §5.3）—— 用源码扫描钉死，防后人加出反向或循环依赖；
 * 3. ★ **K12 回归锁**：`collectCompletedFacts` 必须跳过 `result.ok !== true` 的步骤。
 *
 * ★ 第三条是这个拆分里唯一一处**行为修复**（其余全是纯搬运）：
 * `ok:false` 的澄清步骤若已写入 `result`，它的记录会被当成**事实**计入成本重算 ——
 * 与 P1（悄悄换城）/ dropped（悄悄丢事实）/ zod strip（悄悄丢字段）同属「静默」这一失败类型。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { zRunContext } from '@/shared/run/types';
import type { Plan } from '@/shared/plan/types';
import {
  collectCompletedFacts,
  createTripProviders,
  validateTripPlan,
} from '@/src/domains/travel/providers';
import { listVisionRecords } from '@/src/domains/travel/providers/vision';
import { makePlan, makeStep } from './fixtures';

const CTX = zRunContext.parse({
  runId: 'run-split',
  traceId: 'trace-split',
  goalId: 'goal-split',
  domainId: 'travel',
  revision: 1,
  startedAt: '2026-01-01T00:00:00.000Z',
  deadlineAt: '2026-01-01T00:00:25.000Z',
  signals: ['text'],
  meta: { simulate: 'none' },
});

/** 目标：上海一日游，预算 2000 —— fixture 估算价 ¥1495（在预算内），注入的事实 ¥9999（超预算）。 */
const GOAL = '上海一日游，预算 2000 元';

const SOURCE_REF = {
  providerId: 'travel.poi',
  namespace: 'travel.poi',
  uri: 'fixture://travel/poi/x',
  label: '行程候选 fixture · 上海 · 景点',
  retrievedAt: '2026-01-01T00:00:00.000Z',
  isEstimate: true,
};

/** 一个 `producesFacts` 的步骤，`result.ok` 由入参决定，data 里放一条 ¥9999 的记录。 */
function factStepWithResult(ok: boolean): Plan['steps'][number] {
  return makeStep({
    id: 's-fact',
    type: 'poi_search',
    status: 'done',
    intent: {
      toolName: 'travel.poiSearch',
      input: { category: 'restaurant', goalSummary: GOAL },
      producesFacts: true,
    },
    result: {
      ok,
      data: { pois: [{ name: '待确认的店', category: 'restaurant', priceCNY: 9999, source: 'fixture://x' }] },
      sourceRefs: [SOURCE_REF],
      isEstimate: true,
      durationMs: 0,
    },
  });
}

const composeStep = makeStep({
  id: 's-compose',
  type: 'itinerary_compose',
  status: 'pending',
  dependsOn: ['s-fact'],
  intent: { toolName: 'travel.itineraryCompose', input: { goalSummary: GOAL }, producesFacts: false },
});

describe('providers 拆分 · 桶的行为未变', () => {
  it('namespace / create / createValidator 与拆分前一致', () => {
    const providers = createTripProviders();
    expect(providers.namespace).toBe('travel.poi');

    const adapters = providers.create(CTX);
    expect(Object.keys(adapters)).toEqual(['travel.poi']);
    expect(adapters['travel.poi']?.id).toBe('travel.poi');

    const validator = providers.createValidator?.(CTX);
    expect(validator?.id).toBe('travel.validator');
    expect(typeof validator?.validate).toBe('function');
  });
});

describe('providers 拆分 · 依赖方向守卫（设计 §5.3）', () => {
  const DIR = new URL('../domains/travel/providers/', import.meta.url);

  /**
   * 扫出文件里所有的同目录相对 import（`from './xxx';`）。
   *
   * ★ 必须带上结尾的 `;`：注释里也写了 `from './providers'` 这几个字（说明迁移方式），
   * 只匹配 `from '...'` 会把注释当成 import —— 那正是 CLAUDE.md 警告过的"假通过"反面：
   * 匹配到不该匹配的东西，让守卫看起来在保护其实在乱报。
   */
  function siblingImports(file: string): string[] {
    const source = readFileSync(new URL(file, DIR), 'utf8');
    return [...source.matchAll(/from\s+'(\.\/[A-Za-z0-9_-]+)';/g)].map((match) => match[1]);
  }

  const ALLOWED: Readonly<Record<string, readonly string[]>> = {
    'poi.ts': [],
    'vision.ts': [],
    'mentions.ts': [],
    'compose.ts': ['./poi'],
    'planCheck.ts': ['./poi', './compose'],
    'index.ts': ['./poi', './compose', './planCheck', './mentions', './vision'],
  };

  // ★ 显式超时：这两条要把 6 个源文件整个读一遍再正则扫（纯 I/O + CPU）。
  // 平时 ~1.4s，但全量跑且机器忙时实测撞穿过 vitest 默认的 5s
  // （双倍负载复现过 `Test timed out in 5000ms`）。它们判的是"依赖方向"，
  // 与墙钟无关，不该由"今天机器卡不卡"决定红绿。断言一字不动。
  it(
    '每个子模块只 import 允许的下游（禁止反向依赖）',
    () => {
      for (const [file, allowed] of Object.entries(ALLOWED)) {
        const imports = siblingImports(file);
        for (const spec of imports) {
          expect(allowed, `${file} 不应 import ${spec}`).toContain(spec);
        }
      }
    },
    60_000,
  );

  it(
    '没有任何子模块反向 import 桶（index.ts）—— 否则就是循环依赖',
    () => {
      for (const file of Object.keys(ALLOWED)) {
        if (file === 'index.ts') continue;
        expect(siblingImports(file), `${file} 不得 import ./index`).not.toContain('./index');
      }
    },
    60_000,
  );

  it('mentions.ts 只依赖 shared，不依赖任何数据源子模块', () => {
    expect(siblingImports('mentions.ts')).toEqual([]);
  });
});

describe('★ K12 回归锁：ok:false 的步骤结果不得被当成事实', () => {
  it('collectCompletedFacts 跳过 ok:false（ok:true 时照旧收集 —— 双向锁定）', () => {
    const skipped = collectCompletedFacts(makePlan([factStepWithResult(false), composeStep]));
    expect(skipped.records).toEqual([]);
    // ok:false 的步骤不算"事实步骤缺来源"：它压根没产出事实。
    expect(skipped.missingRefStepIds).toEqual([]);
    expect(skipped.hasAnyFactStep).toBe(true);

    const kept = collectCompletedFacts(makePlan([factStepWithResult(true), composeStep]));
    expect(kept.records).toHaveLength(1);
    expect(kept.missingRefStepIds).toEqual([]);
  });

  it('★ 可观测后果：ok:false 的那条 ¥9999 不再被算进成本，预算校验不再被它打翻', () => {
    const withFailedStep = validateTripPlan(makePlan([factStepWithResult(false), composeStep]));
    expect(withFailedStep.ok).toBe(true);
    expect(withFailedStep.violations.map((v) => v.code)).not.toContain('BUDGET_OVERRUN');

    // 反向：同一个步骤 ok:true → 这条事实进入成本重算 → 超出 ¥2000 预算 → error。
    const withOkStep = validateTripPlan(makePlan([factStepWithResult(true), composeStep]));
    expect(withOkStep.ok).toBe(false);
    expect(withOkStep.violations.map((v) => v.code)).toContain('BUDGET_OVERRUN');
  });
});

describe('vision.ts 数据源（fixture，零网络零密钥）', () => {
  it('未收录的名字 → unresolved：不编造、不丢弃，按入参顺序去重', () => {
    const result = listVisionRecords([
      { id: 'a-1', name: '随便一张图.jpg' },
      { id: 'a-2', name: 'IMG_0002.png' },
      { id: 'a-1', name: '随便一张图.jpg' },
    ]);
    expect(result.identified).toEqual([]);
    expect(result.unresolvedAssetIds).toEqual(['a-1', 'a-2']);
  });

  it('★ 收录的名字 → identified：assetId 是真实入参 id，且每条都带 source', () => {
    const result = listVisionRecords([{ id: 'asset-x', name: '外滩.jpg' }]);
    expect(result.unresolvedAssetIds).toEqual([]);
    expect(result.identified).toHaveLength(1);
    expect(result.identified[0].assetId).toBe('asset-x');
    expect(result.identified[0].identifiedName).toBe('外滩');
    expect(result.identified[0].source.length).toBeGreaterThan(0);
    expect(result.identified[0].confidence).toBeGreaterThan(0);
  });

  it('去扩展名匹配：@外滩 与 外滩.jpg 命中同一条 fixture', () => {
    const withExt = listVisionRecords([{ id: 'x', name: '外滩.jpg' }]);
    const noExt = listVisionRecords([{ id: 'x', name: '外滩' }]);
    expect(noExt.identified[0]?.identifiedName).toBe(withExt.identified[0]?.identifiedName);
  });

  it('纯函数：同样入参两次结果一致', () => {
    const assets = [{ id: 'a-1', name: '外滩.jpg' }];
    expect(listVisionRecords(assets)).toEqual(listVisionRecords(assets));
  });
});
