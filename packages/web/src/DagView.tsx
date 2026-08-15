import { useMemo } from 'react';
import { Background, Controls, ReactFlow, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { WorkflowState } from '@karyakram/core';

export interface DagStep {
  seq: number;
  kind: 'activity' | 'timer';
  label: string;
}

function statusColor(status: string | undefined): string {
  switch (status) {
    case 'COMPLETED':
    case 'FIRED':
      return '#bbf7d0';
    case 'FAILED':
      return '#fecaca';
    case 'SCHEDULED':
      return '#fef08a';
    default:
      // Not reached yet at the current scrub position.
      return '#e5e7eb';
  }
}

/**
 * One node per ActivityScheduled/TimerScheduled event, edges in
 * scheduling order. Every workflow in this codebase today is a
 * sequential chain, so this renders a straight line — it isn't wrong for
 * concurrent workflows, just unexercised by anything that exists yet.
 * See docs/05-control-plane.md.
 */
export function DagView({ steps, state }: { steps: DagStep[]; state: WorkflowState }) {
  const nodes: Node[] = useMemo(
    () =>
      steps.map((step, i) => {
        const status =
          step.kind === 'activity'
            ? state.activities[step.seq]?.status
            : state.timers[step.seq]?.status;
        return {
          id: String(step.seq),
          position: { x: 0, y: i * 90 },
          data: { label: `${step.label} (${status ?? 'not yet reached'})` },
          style: {
            background: statusColor(status),
            border: '1px solid #333',
            borderRadius: 8,
            padding: 8,
            width: 220,
          },
        };
      }),
    [steps, state],
  );

  const edges: Edge[] = useMemo(
    () =>
      steps.slice(1).map((step, i) => ({
        id: `e${String(steps[i]!.seq)}-${String(step.seq)}`,
        source: String(steps[i]!.seq),
        target: String(step.seq),
      })),
    [steps],
  );

  return (
    <div style={{ height: 400, border: '1px solid #ddd', borderRadius: 8 }}>
      <ReactFlow nodes={nodes} edges={edges} fitView>
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}
