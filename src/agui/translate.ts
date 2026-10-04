import { EventType, type Event, type JsonPatch, type ResumeEntry } from '@ag-ui/core';
import { z } from 'zod';
import type { StreamEvent } from '@/shared/stream/events';

/** An AG-UI protocol event produced by the kernel event translator. */
export type AguiEvent = Event;

export interface TranslatorOptions {
  threadId: string;
  runId: string;
}

export interface Translator {
  /** Translate one trusted kernel event into zero or more ordered AG-UI events. */
  push(kernelEvent: StreamEvent): AguiEvent[];
}

const FALLBACK_ACTIVITY_TYPE = 'unknown';

const zAnswers = z.record(z.string(), z.string());
const zWrappedAnswers = z.object({ answers: zAnswers });

/**
 * Merge resolved AG-UI resume payloads into the answer map consumed by the kernel.
 *
 * Both the CopilotKit wrapper shape (`{ answers: {...} }`) and a direct answer map
 * are accepted. Later resume entries win when the same answer key occurs twice.
 * Invalid resolved payloads throw instead of being silently discarded.
 *
 * ★ **Keys are passed through verbatim — no `makeFormKey` / prefix rewriting here.**
 * The answer key is minted exactly once, on the client:
 * - tool clarification → `makeFormKey(questionId, fieldId)` = `questionId::fieldId`
 *   (consumed by the domain pack, e.g. `src/domains/travel/tools.ts`);
 * - goal clarification → the engine-issued `questionId` (e.g. `clarify:constraint.budget`),
 *   consumed by `applyAnswers` in `src/core/goal/clarify.ts`.
 * Composing a key a second time on this side would yield `qid::qid::fid`, which
 * no consumer looks up and which fails silently — exactly the failure class this
 * endpoint is required to surface rather than swallow.
 */
export function mergeResumeAnswers(
  resume: readonly Pick<ResumeEntry, 'status' | 'payload'>[],
): Record<string, string> {
  const answers: Record<string, string> = {};

  for (const entry of resume) {
    if (entry.status !== 'resolved') {
      // Cancelled interrupts intentionally contribute no answers to the next run.
      continue;
    }

    const wrapped = zWrappedAnswers.safeParse(entry.payload);
    if (wrapped.success) {
      Object.assign(answers, wrapped.data.answers);
      continue;
    }

    const direct = zAnswers.safeParse(entry.payload);
    if (direct.success) {
      Object.assign(answers, direct.data);
      continue;
    }

    throw new TypeError('Resolved resume payload must be an answers map or contain an answers map');
  }

  return answers;
}

function createRunFinishedEvent(
  event: Extract<StreamEvent, { type: 'done' }>,
  options: TranslatorOptions,
): AguiEvent {
  if (event.status === 'awaiting_user') {
    return {
      type: EventType.RUN_FINISHED,
      threadId: options.threadId,
      runId: options.runId,
      outcome: {
        type: 'interrupt',
        interrupts: [
          {
            id: `clarify:${options.runId}`,
            reason: event.reason ?? 'STEP_AWAITING_USER',
            responseSchema: {
              type: 'object',
              properties: {
                answers: {
                  type: 'object',
                  additionalProperties: { type: 'string' },
                },
              },
              required: ['answers'],
              additionalProperties: false,
            },
          },
        ],
      },
    };
  }

  if (event.status === 'paused' || event.status === 'aborted') {
    return {
      type: EventType.RUN_FINISHED,
      threadId: options.threadId,
      runId: options.runId,
      outcome: { type: 'cancelled' },
    };
  }

  return {
    type: EventType.RUN_FINISHED,
    threadId: options.threadId,
    runId: options.runId,
    // A failed kernel run already emitted RUN_ERROR; AG-UI must not receive a
    // second error for the same failure, so failed closes with success here.
    outcome: { type: 'success' },
  };
}

/**
 * Create a stateful, deterministic adapter from kernel stream events to AG-UI.
 * State is scoped to one run and only tracks identifiers required by JSON Patch.
 */
export function createTranslator(options: TranslatorOptions): Translator {
  const planSnapshots = new Set<string>();
  const stepIndexes = new Map<string, Map<string, number>>();
  const stepTitles = new Map<string, Map<string, string>>();
  const stepCounts = new Map<string, number>();
  const componentTypes = new Map<string, string>();
  const componentSnapshots = new Set<string>();
  const bodyMessageId = `body-${options.runId}`;
  let bodyStarted = false;
  let bodyEnded = false;

  const startBodyIfNeeded = (delta: string): AguiEvent[] => {
    if (delta.trim().length === 0 || bodyEnded) return [];

    const events: AguiEvent[] = [];
    if (!bodyStarted) {
      bodyStarted = true;
      events.push({
        type: EventType.TEXT_MESSAGE_START,
        messageId: bodyMessageId,
        role: 'assistant',
      });
    }
    events.push({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: bodyMessageId, delta });
    return events;
  };

  const ensurePlanSnapshot = (planId: string): AguiEvent[] => {
    if (planSnapshots.has(planId)) return [];

    planSnapshots.add(planId);
    stepIndexes.set(planId, new Map<string, number>());
    stepTitles.set(planId, new Map<string, string>());
    stepCounts.set(planId, 0);
    return [
      {
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: `plan-${planId}`,
        activityType: 'plan',
        content: {
          planId,
          revision: 0,
          status: 'draft',
          summary: '',
          steps: [],
        },
        replace: true,
      },
    ];
  };

  const ensureComponentSnapshot = (nodeId: string): AguiEvent[] => {
    if (componentSnapshots.has(nodeId)) return [];

    const activityType = componentTypes.get(nodeId) ?? FALLBACK_ACTIVITY_TYPE;
    componentTypes.set(nodeId, activityType);
    componentSnapshots.add(nodeId);
    return [
      {
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: nodeId,
        activityType,
        content: {},
        replace: true,
      },
    ];
  };

  return {
    push(kernelEvent: StreamEvent): AguiEvent[] {
      switch (kernelEvent.type) {
        case 'plan_start': {
          planSnapshots.add(kernelEvent.planId);
          stepIndexes.set(kernelEvent.planId, new Map<string, number>());
          stepTitles.set(kernelEvent.planId, new Map<string, string>());
          stepCounts.set(kernelEvent.planId, 0);

          const events: AguiEvent[] = [
            {
              type: EventType.ACTIVITY_SNAPSHOT,
              messageId: `plan-${kernelEvent.planId}`,
              activityType: 'plan',
              content: {
                planId: kernelEvent.planId,
                revision: kernelEvent.revision,
                status: kernelEvent.status,
                summary: kernelEvent.summary,
                steps: [],
              },
              replace: true,
            },
          ];
          events.push(...startBodyIfNeeded(kernelEvent.summary));
          return events;
        }

        case 'plan_status':
          return [
            ...ensurePlanSnapshot(kernelEvent.planId),
            {
              type: EventType.ACTIVITY_DELTA,
              messageId: `plan-${kernelEvent.planId}`,
              activityType: 'plan',
              patch: [
                { op: 'replace', path: '/status', value: kernelEvent.status },
                { op: 'replace', path: '/revision', value: kernelEvent.revision },
              ],
            },
          ];

        case 'step_add': {
          const snapshots = ensurePlanSnapshot(kernelEvent.planId);
          const indexes = stepIndexes.get(kernelEvent.planId)!;
          const titles = stepTitles.get(kernelEvent.planId)!;
          const index = stepCounts.get(kernelEvent.planId) ?? 0;
          indexes.set(kernelEvent.step.id, index);
          titles.set(kernelEvent.step.id, kernelEvent.step.title);
          stepCounts.set(kernelEvent.planId, index + 1);

          return [
            ...snapshots,
            {
              type: EventType.ACTIVITY_DELTA,
              messageId: `plan-${kernelEvent.planId}`,
              activityType: 'plan',
              patch: [{ op: 'add', path: '/steps/-', value: kernelEvent.step }],
            },
          ];
        }

        case 'step_status': {
          const index = stepIndexes.get(kernelEvent.planId)?.get(kernelEvent.stepId);
          if (index === undefined) {
            // Index-less JSON Patch would target the wrong step. Dropping this
            // explicitly is safer than guessing an array position.
            return [];
          }

          const patch: JsonPatch = [
            { op: 'replace', path: `/steps/${index}/status`, value: kernelEvent.status },
          ];
          if (kernelEvent.attempt !== undefined) {
            patch.push({
              op: 'replace',
              path: `/steps/${index}/attempt`,
              value: kernelEvent.attempt,
            });
          }
          if (kernelEvent.reason !== undefined) {
            patch.push({
              op: 'replace',
              path: `/steps/${index}/reason`,
              value: kernelEvent.reason,
            });
          }

          const events: AguiEvent[] = [
            {
              type: EventType.ACTIVITY_DELTA,
              messageId: `plan-${kernelEvent.planId}`,
              activityType: 'plan',
              patch,
            },
          ];
          // The current kernel calls the successful terminal state `done`.
          // `succeeded` is accepted as a wire-compatibility alias for producers
          // using the terminology from the AG-UI adapter contract.
          const status = String(kernelEvent.status);
          if (status === 'done' || status === 'succeeded') {
            const title = stepTitles.get(kernelEvent.planId)?.get(kernelEvent.stepId);
            if (title) events.push(...startBodyIfNeeded(`\n- ${title}`));
          }
          return events;
        }

        case 'component_start':
          componentTypes.set(kernelEvent.nodeId, kernelEvent.component);
          componentSnapshots.add(kernelEvent.nodeId);
          return [
            {
              type: EventType.ACTIVITY_SNAPSHOT,
              messageId: kernelEvent.nodeId,
              activityType: kernelEvent.component,
              content: {},
              replace: true,
            },
          ];

        case 'component_props_delta': {
          const snapshots = ensureComponentSnapshot(kernelEvent.nodeId);
          return [
            ...snapshots,
            {
              type: EventType.ACTIVITY_DELTA,
              messageId: kernelEvent.nodeId,
              activityType: componentTypes.get(kernelEvent.nodeId) ?? FALLBACK_ACTIVITY_TYPE,
              // Both contracts use RFC 6902. Preserve the exact patch object and
              // ordering rather than rebuilding it operation by operation.
              patch: kernelEvent.patch as JsonPatch,
            },
          ];
        }

        case 'component_end': {
          const snapshots = ensureComponentSnapshot(kernelEvent.nodeId);
          return [
            ...snapshots,
            {
              type: EventType.ACTIVITY_DELTA,
              messageId: kernelEvent.nodeId,
              activityType: componentTypes.get(kernelEvent.nodeId) ?? FALLBACK_ACTIVITY_TYPE,
              patch: [{ op: 'replace', path: '/status', value: kernelEvent.status }],
            },
          ];
        }

        case 'error':
          return [
            {
              type: EventType.RUN_ERROR,
              message: kernelEvent.message,
              code: kernelEvent.recoverable ? 'RECOVERABLE' : 'FATAL',
            },
          ];

        case 'done': {
          const events: AguiEvent[] = [];
          if (bodyStarted && !bodyEnded) {
            bodyEnded = true;
            events.push({ type: EventType.TEXT_MESSAGE_END, messageId: bodyMessageId });
          }
          events.push(createRunFinishedEvent(kernelEvent, options));
          return events;
        }
      }

      const unexpectedEvent: never = kernelEvent;
      throw new Error(`Unsupported kernel event: ${JSON.stringify(unexpectedEvent)}`);
    },
  };
}
