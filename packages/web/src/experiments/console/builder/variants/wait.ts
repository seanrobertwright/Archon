/** Wait variant: defaults + sparse fromDag/toDag conversion. */
import type { WaitNodeData, WireDagNode } from '../types';

export function defaultWaitData(): WaitNodeData {
  return { duration_ms: 60_000 };
}

export function waitFromDag(variantSpecific: Partial<WireDagNode>): WaitNodeData {
  if (variantSpecific.wait === undefined) {
    throw new Error(
      "waitFromDag: wire node has no 'wait' field — use defaultWaitData() for new nodes"
    );
  }
  return { ...variantSpecific.wait };
}

export function waitToDag(data: WaitNodeData): Partial<WireDagNode> {
  if (data.duration_ms !== undefined) return { wait: { duration_ms: data.duration_ms } };
  if (data.until !== undefined) return { wait: { until: data.until } };
  if (data.event !== undefined && data.deadline_ms !== undefined) {
    return { wait: { event: data.event, deadline_ms: data.deadline_ms } };
  }
  throw new Error('waitToDag: wait configuration is incomplete');
}
