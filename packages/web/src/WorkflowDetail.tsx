import { useMemo, useState } from 'react';
import { foldEvents, type StoredWorkflowEvent } from '@karyakram/core';
import { DagView, type DagStep } from './DagView';
import { useWorkflowEvents } from './useWorkflowEvents';

function toDagStep(e: StoredWorkflowEvent): DagStep | null {
  if (e.event.type === 'ActivityScheduled') {
    return { seq: e.seq, kind: 'activity', label: e.event.activityType };
  }
  if (e.event.type === 'TimerScheduled') {
    return { seq: e.seq, kind: 'timer', label: `timer (fires ${e.event.fireAt})` };
  }
  return null;
}

export function WorkflowDetail({ workflowId, onBack }: { workflowId: string; onBack: () => void }) {
  const events = useWorkflowEvents(workflowId);
  const [scrubberPos, setScrubberPos] = useState<number | null>(null);

  // null = "follow the latest event automatically"; once the user drags
  // the scrubber, it pins to that position until they jump back to live.
  const effectivePos = scrubberPos ?? events.length;
  const visibleEvents = useMemo(() => events.slice(0, effectivePos), [events, effectivePos]);
  const state = useMemo(() => foldEvents(visibleEvents), [visibleEvents]);

  const steps: DagStep[] = useMemo(
    () => events.map(toDagStep).filter((step): step is DagStep => step !== null),
    [events],
  );

  const isLive = scrubberPos === null;

  return (
    <div className="page">
      <button className="link-button" onClick={onBack}>
        &larr; Back to workflows
      </button>
      <h2>Workflow {workflowId}</h2>

      <div className="scrubber">
        <label htmlFor="scrubber-input">
          Time travel — seq {effectivePos} / {events.length}
          {isLive && events.length > 0 ? ' (live)' : ''}
        </label>
        <input
          id="scrubber-input"
          type="range"
          min={0}
          max={events.length}
          value={effectivePos}
          disabled={events.length === 0}
          onChange={(e) => setScrubberPos(Number(e.target.value))}
        />
        {!isLive && (
          <button className="link-button" onClick={() => setScrubberPos(null)}>
            Jump to latest
          </button>
        )}
      </div>

      <DagView steps={steps} state={state} />

      <h3>State reconstructed by folding events 1..{effectivePos}</h3>
      <pre className="state-panel">{JSON.stringify(state, null, 2)}</pre>

      <h3>Event log</h3>
      <ol className="event-log">
        {events.map((e) => (
          <li key={e.seq} className={e.seq <= effectivePos ? 'included' : 'excluded'}>
            {e.seq}. {e.event.type}
            {'activityType' in e.event ? ` (${e.event.activityType})` : ''}
          </li>
        ))}
      </ol>
    </div>
  );
}
