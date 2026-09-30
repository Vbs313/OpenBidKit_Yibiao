import type { BidAnalysisMode } from '../../../shared/types/domains/technical-plan';
import catalogJson from '../../../shared/prompts/bidAnalysisTasks.json';

export interface BidAnalysisTaskDefinition {
  id: string;
  label: string;
  description: string;
  required: boolean;
  output: 'markdown' | 'json';
  buildTaskPrompt: () => string;
}

interface CatalogTaskDefinition {
  id: string;
  label: string;
  description: string;
  required: boolean;
  output: 'markdown' | 'json';
  prompt: string;
}

const catalogTasks = (catalogJson.tasks || []) as CatalogTaskDefinition[];

export const BID_ANALYSIS_MISSING_RESULT = '未提取到';

// 仅将 Markdown 整项固定标记识别为未提取，避免误判局部缺失。
export function isMissingBidAnalysisResult(task: BidAnalysisTaskDefinition | undefined, content: string | undefined) {
  return task?.output === 'markdown' && String(content || '').trim() === BID_ANALYSIS_MISSING_RESULT;
}

/** 与 electron/services/tasks/bidAnalysisCatalog.cjs 共用 src/shared/prompts/bidAnalysisTasks.json */
export const bidAnalysisTasks: BidAnalysisTaskDefinition[] = catalogTasks.map((task) => ({
  id: task.id,
  label: task.label,
  description: task.description,
  required: Boolean(task.required),
  output: task.output,
  buildTaskPrompt: () => task.prompt,
}));

export function getBidAnalysisTasks(mode: BidAnalysisMode) {
  return mode === 'full' ? bidAnalysisTasks : bidAnalysisTasks.filter((task) => task.required);
}

export function getBidAnalysisTaskById(taskId: string) {
  return bidAnalysisTasks.find((task) => task.id === taskId);
}
