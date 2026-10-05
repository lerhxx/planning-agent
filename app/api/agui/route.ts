/**
 * `POST /api/agui` — AG-UI SSE transport for the planning kernel.
 *
 * This endpoint intentionally lives beside (and does not modify) `/api/run`.
 *
 * 附件通道：AG-UI 协议没有附件槽位，附件走 `forwardedProps.attachments`
 * （解析与 K9 兜底见 `./attachments`）。
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
import { createRuntime } from '@/src/core/runtime/factory';
import { registerAllDomains } from '@/src/domains';
import { resolveDomainId } from '@/src/agui/domain';
import { createTranslator, mergeResumeAnswers } from '@/src/agui/translate';
import {
  BAD_ATTACHMENTS,
  parseForwardedAttachments,
  resolveRequireConstraints,
} from './attachments';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const zRunOptionsSource = z.object({
  domainId: z.string().min(1).optional(),
  simulate: z.enum(['none', 'retryable', 'fatal', 'clarify']).optional(),
  replanMode: z.enum(['diverge', 'stagnant']).optional(),
  requireConstraints: z.boolean().optional(),
  /**
   * ★ 显式要求走真模型（v3 新增）。缺省 false —— 默认仍是 mock。
   *
   * 传 true 但服务端没配模型环境变量时，`createRuntime` 会**抛错**，
   * 由本路由的 catch 转成 `RUN_ERROR`。这是刻意的：
   * 悄悄退回脚本数据、让用户以为在跑真模型，是欺骗性降级（见 runtime/factory.ts）。
   */
  realModel: z.boolean().optional(),
});

const zRunOptions = z.object({
  domainId: z.string().min(1).optional(),
  simulate: z.enum(['none', 'retryable', 'fatal', 'clarify']).default('none'),
  replanMode: z.enum(['diverge', 'stagnant']).default('diverge'),
  requireConstraints: z.boolean().default(false),
  realModel: z.boolean().default(false),
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

  // 附件通道：`forwardedProps.attachments` → `EngineInput.attachments`。
  // 校验失败必须 400（BAD_ATTACHMENTS），绝不退化成"当没传"——静默丢附件最难排查。
  const parsedAttachments = parseForwardedAttachments(input.forwardedProps);
  if (!parsedAttachments.ok) {
    return Response.json(
      {
        error: BAD_ATTACHMENTS,
        message: parsedAttachments.message,
        issues: parsedAttachments.issues,
      },
      { status: 400 },
    );
  }
  const attachments = parsedAttachments.attachments;

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
      let errored = false;

      const writeEvent = (event: AguiEvent): void => {
        if (closed) return;
        /*
         * ★ 终态事件互斥：RUN_FINISHED 与 RUN_ERROR 都是 run 的终态，
         *   发过其一后就不再发另一个。否则 AG-UI 客户端会抛
         *   "Cannot send event type 'RUN_FINISHED': The run has already errored"
         *   （本地实测：真模型调用失败时先发 RUN_ERROR 再发 RUN_FINISHED 必炸）。
         *   这道守卫让任何路径都不可能错位发送终态事件。
         */
        if (
          (event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR) &&
          (terminalSent || errored)
        ) {
          return;
        }

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
          if (event.type === EventType.RUN_ERROR) errored = true;
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
            // ★ K9 兜底：有附件时强制关掉 requireConstraints（见 ./attachments）。
            requireConstraints: resolveRequireConstraints(options.requireConstraints, attachments),
            ...(answers === undefined ? {} : { answers }),
            // 有才给：没传附件时不塞 `[]`，保持与既有 run options 一致的风格。
            ...(attachments === undefined ? {} : { attachments }),
          },
          {
            /*
             * v3：runtime 由工厂按显式开关选择（默认仍是 MockRuntime）。
             * 缺模型配置时 `createRuntime` 会抛，由下面的 catch 转成 RUN_ERROR ——
             * 不存在"悄悄退回 mock"的路径。
             */
            runtime: createRuntime({
              preferReal: options.realModel,
              mockLatencyMs: 120,
              mockReplanMode: options.replanMode,
            }),
            emit,
            sleep,
            signal: request.signal,
          },
        );
        finishRun();
      } catch (error) {
        console.error('AG-UI run failed', error);
        if (!terminalSent && !errored) {
          /*
           * ★ RUN_ERROR 是终态事件，AG-UI 协议禁止在其之后再发 RUN_FINISHED。
           *   这里只发 RUN_ERROR，绝不再调 finishRun() —— 否则客户端会抛
           *   "Cannot send event type 'RUN_FINISHED': The run has already errored"。
           *   （此前默认走 mock 永不进此分支，故潜伏至今；真模型调用失败后
           *   第一次走到这里才暴露。）
           */
          writeEvent({
            type: EventType.RUN_ERROR,
            message: error instanceof Error ? error.message : '内部错误',
            code: 'INTERNAL_ERROR',
          });
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
