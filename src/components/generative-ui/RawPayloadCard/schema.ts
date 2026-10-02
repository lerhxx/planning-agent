import { z } from 'zod';

/** 一级降级：schema 校验失败或组件未注册时，把原始载荷原样呈现（绝不白屏）。 */
export const zRawPayloadCardProps = z.object({
  title: z.string().optional(),
  reason: z.string().optional(),
  payload: z.unknown().optional(),
  traceId: z.string().optional(),
});

export type RawPayloadCardProps = z.infer<typeof zRawPayloadCardProps>;
