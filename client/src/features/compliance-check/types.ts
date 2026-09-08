export type ComplianceCheckId = 'pricing_arithmetic';

export type ComplianceCheckStatus = 'pass' | 'fail' | 'warning' | 'error';
export type ComplianceSeverity = 'info' | 'minor' | 'major' | 'critical';
export type ComplianceCheckStep = 'configure' | 'running' | 'done';

export interface ComplianceCheckFindingLocation {
  file?: string | null;
  line?: number | null;
}

export interface ComplianceCheckFinding {
  id: string;
  code: string;
  title: string;
  message: string;
  severity: ComplianceSeverity;
  evidence: string;
  suggestion: string;
  location?: ComplianceCheckFindingLocation;
}

export interface ComplianceCheckMetrics {
  total: number;
  passed: number;
  failed: number;
  warning: number;
}

export interface ComplianceCheckUsage {
  model: string | null;
  prompt_tokens: number;
  completion_tokens: number;
}

export interface ComplianceCheckResult {
  check_id: string;
  check_name: string;
  status: ComplianceCheckStatus;
  severity: ComplianceSeverity;
  summary: string;
  metrics: ComplianceCheckMetrics;
  findings: ComplianceCheckFinding[];
  usage: ComplianceCheckUsage;
}

export interface ComplianceCheckProtocolError {
  code: string;
  message: string;
  detail?: string;
}

export interface ComplianceCheckResponse {
  version: string;
  job_id: string;
  status: 'success' | 'error';
  results: ComplianceCheckResult[];
  error?: ComplianceCheckProtocolError;
  message?: string;
}

export interface ComplianceCheckInput {
  tender_file?: string;
  bid_file?: string;
  project_metadata?: Record<string, unknown>;
  checks?: string[];
}

export interface ComplianceCheckTaskState {
  task_id?: string;
  type?: string;
  status?: string;
  progress?: number;
  logs?: string[];
  error?: string;
  stats?: unknown;
  started_at?: string;
  updated_at?: string;
}

export interface ComplianceCheckState {
  step: ComplianceCheckStep;
  input: ComplianceCheckInput;
  checkTask?: ComplianceCheckTaskState;
  lastReport?: ComplianceCheckResponse | null;
}

export interface ComplianceCheckWorkspacePatch {
  step?: ComplianceCheckStep;
  input?: ComplianceCheckInput;
  checkTask?: ComplianceCheckTaskState;
  lastReport?: ComplianceCheckResponse | null;
}

export interface ComplianceCheckFileSelectionResult {
  canceled: boolean;
  filePath: string;
}

export interface ComplianceCheckPingResult {
  ok: boolean;
  message: string;
}
