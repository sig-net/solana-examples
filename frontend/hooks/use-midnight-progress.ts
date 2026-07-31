'use client';

import { useEffect, useState } from 'react';

import { flow, PHASE_MESSAGE, type FlowState } from '@/lib/midnight/flow';

// Expose the Midnight flow as a message for the existing LoadingState UI.
export function useMidnightProgress(): {
  active: boolean;
  message: string;
  error: string | null;
} {
  const [s, setS] = useState<FlowState>({
    kind: flow.kind,
    phase: flow.phase,
    error: flow.error,
  });
  useEffect(() => flow.subscribe(setS), []);
  return {
    active: !!s.phase && s.phase !== 'done',
    message: s.phase ? (PHASE_MESSAGE[s.phase] ?? 'Working…') : 'Working…',
    error: s.error,
  };
}
