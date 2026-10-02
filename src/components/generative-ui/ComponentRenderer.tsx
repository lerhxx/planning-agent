'use client';

import { lazy, Suspense, useMemo } from 'react';
import { CORE_DEGRADE_CHAIN, type DegradeChain } from '@/shared/domain/types';
import { decideDegrade, isPropsComplete } from '@/src/core/degrade/policy';
import { resolveComponent } from './registry';
import ErrorState from './ErrorState';
import RawPayloadCard from './RawPayloadCard';
import SkeletonList from './SkeletonList';
import type { ComponentAction } from './ClarifyOptions/schema';

/** 一个待渲染的组件节点（结构上与 `nodeReducer` 的 ComponentNode 一致）。 */
export interface RenderableNode {
  nodeId: string;
  component: string;
  props: Record<string, unknown>;
  status: 'streaming' | 'ready' | 'degraded' | 'error';
  stepId?: string;
  traceId?: string;
}

export interface ComponentRendererProps {
  node: RenderableNode;
  domainId: string;
  degradeChain?: DegradeChain;
  onAction?: (action: ComponentAction) => void;
}

/**
 * 生成式 UI 的唯一渲染入口：**zod 校验 → 失败降级 → 查表 → lazy 加载**。
 *
 * 三级降级全部集中在这里，与传输层解耦（CONSTRAINTS L3）。
 * 任何分支都必须能渲染 —— 包括"组件名根本不存在"这种情况。
 */
export default function ComponentRenderer(props: ComponentRendererProps) {
  const { node, domainId, onAction } = props;
  const chain = props.degradeChain ?? CORE_DEGRADE_CHAIN;

  const definition = resolveComponent(domainId, node.component);
  const parsed = definition?.schema.safeParse(node.props ?? {});

  // hooks 必须在任何提前 return 之前调用。
  const LazyComponent = useMemo(
    () => (definition?.load ? lazy(definition.load) : null),
    [definition],
  );

  const decision = decideDegrade({
    componentKnown: definition !== undefined && definition.load !== undefined,
    parseOk: parsed?.success ?? false,
    propsComplete: definition ? isPropsComplete(node.props ?? {}, definition.requiredProps) : false,
    hasError: node.status === 'error',
    needsClarify: false,
    chain,
  });

  if (decision.level === 'skeleton') {
    return <SkeletonList rows={3} label="组件生成中" />;
  }

  if (decision.level === 'error') {
    return (
      <ErrorState
        title="组件渲染失败"
        message={decision.reason}
        traceId={node.traceId}
        recoverable
      />
    );
  }

  if (decision.level === 'raw' || LazyComponent === null) {
    return (
      <RawPayloadCard
        title={`${node.component} 渲染降级`}
        reason={decision.level === 'raw' ? decision.reason : '组件未提供懒加载入口'}
        payload={node.props}
        traceId={node.traceId}
      />
    );
  }

  return (
    <Suspense fallback={<SkeletonList rows={2} label="组件加载中" />}>
      <LazyComponent
        {...(parsed?.success ? (parsed.data as Record<string, unknown>) : {})}
        onAction={onAction}
      />
    </Suspense>
  );
}
