/**
 * ★ 规划器 JSON 抽取（修复 DeepSeek 不支持 json_schema 的连带改动）。
 *
 * `extractPlanJson` 现在负责从 `agent.generate` 的**文本**输出里抠出 JSON，
 * 不再依赖 `response_format: { type: "json_schema" }`（DeepSeek 不支持，会 400）。
 * 这条抽取路径此前没有任何测试 —— 而它正是真模型失败报错后我们改出来的核心逻辑，
 * 必须有测试钉死，否则又会像"样例数据死变量"那样潜伏。
 */
import { describe, expect, it } from 'vitest';
import { extractPlanJson } from '@/src/core/runtime/mastra/agent';

describe('extractPlanJson（从模型文本抠 JSON）', () => {
  it('直接 JSON 文本 → 解析为对象', () => {
    const text =
      '{"summary":"两步","steps":[{"type":"demo.gather","title":"收集","dependsOn":[],"intent":null}]}';
    expect(extractPlanJson({ text })).toMatchObject({ summary: '两步' });
  });

  it('带 ```json 围栏 → 仍能解析', () => {
    const text = '好的，这是计划：\n```json\n{"summary":"x","steps":[]}\n```';
    expect(extractPlanJson({ text })).toMatchObject({ summary: 'x' });
  });

  it('前后有散文包裹 → 取第一个 { 到最后一个 }', () => {
    const text = '下面是结果：{"summary":"y","steps":[]} 以上为规划。';
    expect(extractPlanJson({ text })).toMatchObject({ summary: 'y' });
  });

  it('纯散文、无 JSON → undefined（交由 parse.ts 判校验失败）', () => {
    expect(extractPlanJson({ text: '抱歉我无法规划' })).toBeUndefined();
  });

  it('非对象结果（字符串 / null / 空对象）→ undefined', () => {
    expect(extractPlanJson('just text')).toBeUndefined();
    expect(extractPlanJson(null)).toBeUndefined();
    expect(extractPlanJson({})).toBeUndefined();
    expect(extractPlanJson({ text: 123 })).toBeUndefined();
  });

  it('重新启用结构化输出时优先用 result.object', () => {
    const plan = { summary: 'z', steps: [] };
    expect(extractPlanJson({ object: plan, text: 'garbage' })).toBe(plan);
  });
});
