// Deposit/withdraw lifecycle state; vault.ts pushes phases, the UI subscribes.

export type FlowKind = 'deposit' | 'withdraw';

export type FlowPhase =
  | 'preparing'
  | 'proving'
  | 'settling'
  | 'claim-proving'
  | 'done';

export type FlowState = {
  kind: FlowKind | null;
  phase: FlowPhase | null;
  error: string | null;
};

type Listener = (s: FlowState) => void;

class Flow {
  kind: FlowKind | null = null;
  phase: FlowPhase | null = null;
  error: string | null = null;
  private listeners = new Set<Listener>();

  start(kind: FlowKind) {
    this.kind = kind; this.phase = 'preparing'; this.error = null; this.emit();
  }
  set(phase: FlowPhase) { this.phase = phase; this.error = null; this.emit(); }
  fail(message: string) { this.error = message; this.emit(); }
  reset() { this.kind = null; this.phase = null; this.error = null; this.emit(); }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    l(this.snapshot());
    return () => { this.listeners.delete(l); };
  }
  private snapshot(): FlowState { return { kind: this.kind, phase: this.phase, error: this.error }; }
  private emit() { const s = this.snapshot(); for (const l of this.listeners) l(s); }
}

export const flow = new Flow();

export const PHASE_MESSAGE: Record<FlowPhase, string> = {
  preparing: 'Preparing…',
  proving: 'Generating proof (runs locally, can take minutes)…',
  settling: 'MPC signing + settling on Sepolia…',
  'claim-proving': 'Generating settlement proof…',
  done: 'Done',
};
