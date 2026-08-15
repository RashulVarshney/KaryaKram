import { useEffect, useState } from 'react';
import type { StoredWorkflowEvent } from '@karyakram/core';
import { getWorkflowEvents, streamWorkflowEvents } from './api';

/**
 * Fetches full history once, then appends live events via SSE — the
 * scrubber (in WorkflowDetail) doesn't know or care whether an event
 * arrived from the initial fetch or the stream, it just re-folds
 * whatever's in this array. See docs/05-control-plane.md.
 */
export function useWorkflowEvents(workflowId: string): StoredWorkflowEvent[] {
  const [events, setEvents] = useState<StoredWorkflowEvent[]>([]);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    setEvents([]);

    void getWorkflowEvents(workflowId).then((initial) => {
      if (cancelled) return;
      setEvents(initial);

      const lastSeq = initial.length > 0 ? initial[initial.length - 1]!.seq : 0;
      unsubscribe = streamWorkflowEvents(workflowId, lastSeq, (event) => {
        setEvents((prev) => {
          if (prev.some((e) => e.seq === event.seq)) return prev;
          return [...prev, event].sort((a, b) => a.seq - b.seq);
        });
      });
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [workflowId]);

  return events;
}
