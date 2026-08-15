import { useEffect, useState } from 'react';
import { listWorkflows, startWorkflow, type WorkflowSummary } from './api';

export function WorkflowList({ onSelect }: { onSelect: (id: string) => void }) {
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    const refresh = (): void => {
      void listWorkflows().then(setWorkflows);
    };
    refresh();
    const interval = setInterval(refresh, 2_000);
    return () => clearInterval(interval);
  }, []);

  async function handleStart(): Promise<void> {
    setStarting(true);
    try {
      const id = await startWorkflow();
      setWorkflows(await listWorkflows());
      onSelect(id);
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="page">
      <h1>KaryaKram Control Plane</h1>
      <button onClick={() => void handleStart()} disabled={starting}>
        {starting ? 'Starting…' : 'Start a new reserve → charge → ship workflow'}
      </button>

      <table className="workflow-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Type</th>
            <th>Status</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {workflows.map((w) => (
            <tr key={w.id} onClick={() => onSelect(w.id)}>
              <td className="mono">{w.id}</td>
              <td>{w.workflowType}</td>
              <td>
                <span className={`status status-${w.status.toLowerCase()}`}>{w.status}</span>
              </td>
              <td>{new Date(w.updatedAt).toLocaleString()}</td>
            </tr>
          ))}
          {workflows.length === 0 && (
            <tr>
              <td colSpan={4}>No workflows yet — start one above.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
