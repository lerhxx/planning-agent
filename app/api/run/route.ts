/**
 * `POST /api/run` —— 服务端代码唯一入口（禁用 Server Actions，红线 4）。
 *
 * 创建一次 run，并以 SSE 流式下发 plan / step / 组件事件。
 * 客户端断开时 `request.signal` 会 abort，引擎随即将计划置为 `paused`（C0-15）。
 */
import type { StreamEvent } from '@/shared/stream/events';
import { zRunRequest } from '@/shared/run/types';
import { runGoal } from '@/src/core/run/engine';
import { createRuntime } from '@/src/core/runtime/factory';
// 领域包的**服务端唯一引用点**：桶文件，新增领域只改 src/domains/index.ts。
import { registerAllDomains } from '@/src/domains';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function POST(request: Request): Promise<Response> {
  // 进程内首次调用时注册；幂等，重复调用只是覆盖同 id 的包。
  registerAllDomains();

  const body = await request.json().catch(() => null);
  const parsed = zRunRequest.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: 'BAD_REQUEST', issues: parsed.error.issues.slice(0, 5) },
      { status: 400 },
    );
  }

  const input = parsed.data;
  const encoder = new TextEncoder();

  /*
   * v3：显式要求走真模型（默认仍是 mock）。
   *
   * ★ 刻意**不**把它加进 `zRunRequest` —— 那是 `shared/**` 的公开契约，
   *   为了一个调试开关去扩共享契约，会让所有既有调用方与测试都受影响，
   *   远大于收益。这里只做一次窄读取，且必须严格等于 `true` 才算开启。
   */
  const preferReal = (body as { realModel?: unknown } | null)?.realModel === true;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const emit = (event: StreamEvent): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true; // 客户端已断开，静默停止写入
        }
      };

      try {
        await runGoal(
          {
            goal: input.goal,
            domainId: input.domainId,
            simulate: input.simulate,
            requireConstraints: input.requireConstraints,
            answers: input.answers,
            // 附件描述符（引用优先，字节已由 /api/assets 落地）。
            attachments: input.attachments,
            // 续跑：plan 快照 + 编辑命令（都来自客户端，引擎内部会重新校验）。
            resumePlan: input.plan ?? null,
            edit: input.edit ?? null,
          },
          {
            /*
             * v3：runtime 由工厂按显式开关选择（默认仍是 MockRuntime）。
             * 缺模型配置时 `createRuntime` 会抛错，不会悄悄退回 mock。
             */
            runtime: createRuntime({
              preferReal,
              mockLatencyMs: 120,
              mockReplanMode: input.replanMode,
            }),
            emit,
            sleep,
            signal: request.signal,
          },
        );
      } catch (error) {
        emit({
          type: 'error',
          traceId: '',
          message: error instanceof Error ? error.message : '内部错误',
          recoverable: false,
        });
        emit({ type: 'done', traceId: '', status: 'failed', reason: 'INTERNAL_ERROR' });
      }

      closed = true;
      try {
        controller.close();
      } catch {
        // 已关闭
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
