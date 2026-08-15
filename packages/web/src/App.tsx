import { useState } from 'react';
import { WorkflowDetail } from './WorkflowDetail';
import { WorkflowList } from './WorkflowList';

export default function App() {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return selectedId ? (
    <WorkflowDetail workflowId={selectedId} onBack={() => setSelectedId(null)} />
  ) : (
    <WorkflowList onSelect={setSelectedId} />
  );
}
