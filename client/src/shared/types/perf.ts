export interface PerfCounter {
  key: string;
  count: number;
  totalMs: number;
  maxMs: number;
  lastMs: number;
  errors: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  samples: number[];
  updatedAt: string;
}

export interface PerfSnapshot {
  enabled: boolean;
  started_at: string;
  keys: PerfCounter[];
}
