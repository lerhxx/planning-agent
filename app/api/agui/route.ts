/**
 * `POST /api/agui` — AG-UI SSE transport for the planning kernel.
 *
 * This endpoint intentionally lives beside (and does not modify) `/api/run`.
 */
import {
  EventType,
  contentToText,
  type Event as AguiEvent,
  type RunAgentInput,
} from '@ag-ui/core';
import { RunAgentInputSchema } from '@ag-ui/core/schemas';
import { EventEncoder } from '@ag-ui/encoder';
import { z } from 'zod';
import type { StreamEvent } from '@/shared/stream/events';
import { runGoal } from '@/src/core/run/engine';
import { createMockRuntime } from '@/src/core/runtime/mock';
import { registerAllDomains } from '@/src/domains';
import { resolveDomainId } from '@/src/agui/domain';
import { createTranslator, mergeResumeAnswers } from '@/src/agui/translate';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const zRunOptionsSource = z.object({
  domainId: z.string().min(1).optional(),
  simulate: z.enum(['none', 'retryable', 'fatal', 'clarify']).optional(),
  replanMode: z.enum(['diverge', 'stagnant']).optional(),
  requireConstraints: z.boolean().optional(),
});

const zRunOptions = z.object({
  domainId: z.string().min(1).optional(),
  simulate: z.enum(['none', 'retryable', 'fatal', 'clarify']).default('none'),
  replanMode: z.enum(['diverge', 'stagnant']).default('diverge'),
  requireConstraints: z.boolean().default(false),
});

type RunOptions = z.infer<typeof zRunOptions>;

type ParsedRunOptions =
  | { success: true; data: RunOptions }
  | { success: false; error: z.ZodError };

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function parseRunOptions(input: RunAgentInput): ParsedRunOptions {
  const state = zRunOptionsSource.safeParse(input.state ?? {});
  if (!state.success) return state;

  const forwardedProps = zRunOptionsSource.safeParse(input.forwardedProps ?? {});
  if (!forwardedProps.success) return forwardedProps;

  const merged = zRunOptions.safeParse({ ...state.data, ...forwardedProps.data });
  if (!merged.success) return merged;
  return { success: true, data: merged.data };
}

function findGoal(input: RunAgentInput): string | null {
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index];
    if (message.role !== 'user') continue;

    const goal = contentToText(message.content).trim();
    return goal.length > 0 ? goal : null;
  }
  return null;
}

export async function POST(request: Request): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);
  const parsedInput = RunAgentInputSchema.safeParse(body);
  if (!parsedInput.success) {
    return Response.json(
      { error: 'BAD_REQUEST', issues: parsedInput.error.issues.slice(0, 5) },
      { status: 400 },
    );
  }

  const input = parsedInput.data;
  const goal = findGoal(input);
  if (goal === null) return Response.json({ error: 'NO_GOAL' }, { status: 400 });

  const parsedOptions = parseRunOptions(input);
  if (!parsedOptions.success) {
    return Response.json(
      { error: 'BAD_FORWARDED_PROPS', issues: parsedOptions.error.issues.slice(0, 5) },
      { status: 400 },
    );
  }

  registerAllDomains();

  // Explicit domain resolution: absent means "kernel default", but a value that
  // matches no registered pack is rejected rather than silently swapped.
  const resolvedDomain = resolveDomainId(parsedOptions.data.domainId);
  if (!resolvedDomain.ok) {
    return Response.json(
      {
        error: resolvedDomain.reason,
        domainId: resolvedDomain.domainId,
        available: resolvedDomain.available,
      },
      { status: 400 },
    );
  }

  let answers: Record<string, string> | undefined;
  if (input.resume !== undefined) {
    try {
      answers = mergeResumeAnswers(input.resume);
    } catch (error) {
      return Response.json(
        {
          error: 'BAD_RESUME',
          message: error instanceof Error ? error.message : 'Invalid resume payload',
        },
        { status: 400 },
      );
    }
  }

  const options = parsedOptions.data;
  const domainId = resolvedDomain.domainId;
  const eventEncoder = new EventEncoder();
  const textEncoder = new TextEncoder();
  const translator = createTranslator({ threadId: input.threadId, runId: input.runId });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let terminalSent = false;

      const writeEvent = (event: AguiEvent): void => {
        if (closed) return;
        if (event.type === EventType.RUN_FINISHED && terminalSent) return;

        let chunk: Uint8Array;
        try {
          chunk = textEncoder.encode(eventEncoder.encodeSSE(event));
        } catch (error) {
          console.error('Failed to encode AG-UI event', error);
          throw error;
        }

        try {
          controller.enqueue(chunk);
          if (event.type === EventType.RUN_FINISHED) terminalSent = true;
        } catch {
          // Enqueue only fails after the client/stream has closed. The request
          // signal stops the kernel; further transport writes are intentionally ignored.
          closed = true;
        }
      };

      const finishRun = (): void => {
        writeEvent({
          type: EventType.RUN_FINISHED,
          threadId: input.threadId,
          runId: input.runId,
        });
      };

      writeEvent({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
        ...(input.protocolVersion === undefined
          ? {}
          : { protocolVersion: input.protocolVersion }),
      });

      const emit = (kernelEvent: StreamEvent): void => {
        for (const event of translator.push(kernelEvent)) writeEvent(event);
      };

      try {
        await runGoal(
          {
            goal,
            domainId,
            simulate: options.simulate,
            requireConstraints: options.requireConstraints,
            ...(answers === undefined ? {} : { answers }),
          },
          {
            runtime: createMockRuntime({ latencyMs: 120, replanMode: options.replanMode }),
            emit,
            sleep,
            signal: request.signal,
          },
        );
        finishRun();
      } catch (error) {
        console.error('AG-UI run failed', error);
        if (!terminalSent) {
          writeEvent({
            type: EventType.RUN_ERROR,
            message: error instanceof Error ? error.message : '内部错误',
            code: 'INTERNAL_ERROR',
          });
          finishRun();
        }
      }

      closed = true;
      try {
        controller.close();
      } catch {
        // The client may have closed the stream while the kernel was stopping.
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': eventEncoder.getContentType(),
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
