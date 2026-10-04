import { EventType } from '@ag-ui/core';
import { describe, expect, it } from 'vitest';
import type { JsonPatchOperation } from '@/shared/stream/events';
import { makeFormKey, parseFormKey } from '@/shared/plan/types';
import type { RunTerminalStatus } from '@/shared/run/types';
import { makeStep } from '@/src/test/fixtures';
import { createTranslator, mergeResumeAnswers } from './translate';

const OPTIONS = { threadId: 'thread-1', runId: 'run-1' } as const;

function planStart(summary = '') {
  return {
    type: 'plan_start' as const,
    planId: 'plan-1',
    runId: 'kernel-run-1',
    goalId: 'goal-1',
    domainId: 'unit',
    revision: 1,
    status: 'draft' as const,
    summary,
  };
}

describe('createTranslator', () => {
  it('translates step ids to array indexes and drops unknown step ids', () => {
    const translator = createTranslator(OPTIONS);
    translator.push(planStart());
    translator.push({
      type: 'step_add',
      planId: 'plan-1',
      step: makeStep({ id: 'step-a', title: 'First step' }),
    });
    translator.push({
      type: 'step_add',
      planId: 'plan-1',
      step: makeStep({ id: 'step-b', title: 'Second step' }),
    });

    const translated = translator.push({
      type: 'step_status',
      planId: 'plan-1',
      stepId: 'step-b',
      status: 'running',
      attempt: 2,
      reason: 'RETRY',
    });

    expect(translated).toEqual([
      {
        type: EventType.ACTIVITY_DELTA,
        messageId: 'plan-plan-1',
        activityType: 'plan',
        // `add` rather than `replace`: a strict RFC 6902 consumer drops the whole
        // patch when `replace` targets a path that does not exist — and `reason`
        // is absent until this event carries one.
        patch: [
          { op: 'add', path: '/steps/1/status', value: 'running' },
          { op: 'add', path: '/steps/1/attempt', value: 2 },
          { op: 'add', path: '/steps/1/reason', value: 'RETRY' },
        ],
      },
    ]);

    expect(
      translator.push({
        type: 'step_status',
        planId: 'plan-1',
        stepId: 'missing',
        status: 'failed',
      }),
    ).toEqual([]);
  });

  it('passes component JSON Patch through without rebuilding it', () => {
    const translator = createTranslator(OPTIONS);
    const patch: JsonPatchOperation[] = [{ op: 'add', path: '/title', value: 'Ready' }];
    translator.push({ type: 'component_start', nodeId: 'node-1', component: 'ResultCard' });

    const translated = translator.push({
      type: 'component_props_delta',
      nodeId: 'node-1',
      patch,
    });

    expect(translated).toHaveLength(1);
    expect(translated[0].type).toBe(EventType.ACTIVITY_DELTA);
    if (translated[0].type !== EventType.ACTIVITY_DELTA) {
      throw new Error('Expected ACTIVITY_DELTA');
    }
    expect(translated[0].patch).toBe(patch);
  });

  it.each<[RunTerminalStatus, string]>([
    ['completed', 'success'],
    ['failed', 'success'],
    ['paused', 'cancelled'],
    ['aborted', 'cancelled'],
    ['awaiting_user', 'interrupt'],
  ])('maps done status %s to %s outcome', (status, expectedOutcome) => {
    const translator = createTranslator(OPTIONS);
    const translated = translator.push({
      type: 'done',
      traceId: 'trace-1',
      status,
      reason: status === 'awaiting_user' ? 'NEED_INPUT' : undefined,
    });
    const finished = translated.find((event) => event.type === EventType.RUN_FINISHED);

    expect(finished).toBeDefined();
    if (finished?.type !== EventType.RUN_FINISHED) {
      throw new Error('Expected RUN_FINISHED');
    }
    expect(finished.outcome?.type).toBe(expectedOutcome);
    if (finished.outcome?.type === 'interrupt') {
      expect(finished.outcome.interrupts.length).toBeGreaterThanOrEqual(1);
      expect(finished.outcome.interrupts[0]).toMatchObject({
        id: 'clarify:run-1',
        reason: 'NEED_INPUT',
      });
    }
  });

  it('does not create a text stream when there is no summary or successful step', () => {
    const translator = createTranslator(OPTIONS);
    const events = [
      ...translator.push(planStart()),
      ...translator.push({
        type: 'step_add' as const,
        planId: 'plan-1',
        step: makeStep({ id: 'step-a', title: 'First step' }),
      }),
      ...translator.push({
        type: 'step_status' as const,
        planId: 'plan-1',
        stepId: 'step-a',
        status: 'running' as const,
      }),
      ...translator.push({
        type: 'done' as const,
        traceId: 'trace-1',
        status: 'completed' as const,
      }),
    ];

    expect(events.filter((event) => event.type.startsWith('TEXT_MESSAGE_'))).toEqual([]);
  });

  it('lazily emits ordered START, CONTENT and END text events when content exists', () => {
    const translator = createTranslator(OPTIONS);
    const events = [
      ...translator.push(planStart('Plan summary')),
      ...translator.push({
        type: 'step_add' as const,
        planId: 'plan-1',
        step: makeStep({ id: 'step-a', title: 'First step' }),
      }),
      ...translator.push({
        type: 'step_status' as const,
        planId: 'plan-1',
        stepId: 'step-a',
        status: 'done' as const,
      }),
      ...translator.push({
        type: 'done' as const,
        traceId: 'trace-1',
        status: 'completed' as const,
      }),
    ];
    const textEvents = events.filter((event) => event.type.startsWith('TEXT_MESSAGE_'));

    expect(textEvents.map((event) => event.type)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
    ]);
    expect(textEvents).toEqual([
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: 'body-run-1',
        role: 'assistant',
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: 'body-run-1',
        delta: 'Plan summary',
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: 'body-run-1',
        delta: '\n- First step',
      },
      { type: EventType.TEXT_MESSAGE_END, messageId: 'body-run-1' },
    ]);
  });

  it('repairs an out-of-order component stream with SNAPSHOT before DELTA', () => {
    const translator = createTranslator(OPTIONS);
    const translated = translator.push({
      type: 'component_props_delta',
      nodeId: 'late-node',
      patch: [{ op: 'add', path: '/value', value: 1 }],
    });

    expect(translated.map((event) => event.type)).toEqual([
      EventType.ACTIVITY_SNAPSHOT,
      EventType.ACTIVITY_DELTA,
    ]);
    expect(translated[0]).toMatchObject({
      messageId: 'late-node',
      activityType: 'unknown',
      content: {},
    });
    expect(translated[1]).toMatchObject({
      messageId: 'late-node',
      activityType: 'unknown',
    });
  });
});

describe('mergeResumeAnswers', () => {
  it('merges wrapped and direct resolved payloads while ignoring cancelled entries', () => {
    expect(
      mergeResumeAnswers([
        {
          status: 'resolved',
          payload: { answers: { 'question-1::field-1': 'option-a' } },
        },
        {
          status: 'cancelled',
          payload: { 'question-ignored::field': 'option-ignored' },
        },
        {
          status: 'resolved',
          payload: { 'question-2::field-2': 'option-b' },
        },
      ]),
    ).toEqual({
      'question-1::field-1': 'option-a',
      'question-2::field-2': 'option-b',
    });
  });

  it('keeps answer keys verbatim: form keys stay parseable, goal keys stay engine-issued', () => {
    const formKey = makeFormKey('clarify:trip.budget', 'budget');
    const goalKey = 'clarify:constraint.budget';
    const merged = mergeResumeAnswers([
      {
        status: 'resolved',
        payload: { answers: { [formKey]: '["mid"]', [goalKey]: 'provide' } },
      },
    ]);

    // No second makeFormKey composition on the server: that would mint
    // `qid::qid::fid`, which no consumer looks up and which fails silently.
    expect(Object.keys(merged).sort()).toEqual([formKey, goalKey].sort());
    // `::` is the form-key delimiter and must appear exactly once: `parseFormKey`
    // splits on the *last* occurrence, so a doubled delimiter would reappear as a
    // mangled questionId that no domain pack looks up.
    expect(formKey.split('::').length - 1).toBe(1);
    expect(parseFormKey(formKey)).toEqual({
      questionId: 'clarify:trip.budget',
      fieldId: 'budget',
    });
    expect(merged[formKey]).toBe('["mid"]');
    expect(merged[goalKey]).toBe('provide');
  });

  it('rejects malformed resolved payloads instead of silently losing answers', () => {
    expect(() =>
      mergeResumeAnswers([{ status: 'resolved', payload: { answer: 42 } }]),
    ).toThrow(/answers map/);
  });
});
