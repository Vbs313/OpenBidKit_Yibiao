// 废标项检查 / 无效与废标项解析的「启动载荷」计算。
//
// 从 RejectionCheckPage 里抽出来的纯函数：页面只负责「调 IPC + 落 state + 弹 toast」，
// 「启动时该把哪些结果置为 running、签名怎么带、失败补丁长什么样」都在这里，可单测。
//
// 时间戳 / 任务号一律由调用方注入 —— 这样函数保持纯，测试里不用碰 Date.now。

import type {
  LogicCheckResultState,
  RejectionBackgroundTaskState,
  RejectionCheckOptions,
  RejectionCheckResultState,
  RejectionCheckResultTab,
  RejectionExtractionState,
  TypoCheckResultState,
} from '../../shared/types/domains/rejection-check';

export interface RejectionCheckRunPlanInput {
  runOptions: RejectionCheckOptions;
  bidSignature: string;
  rejectionInputSignature: string;
  startedAt: string;
  taskId: string;
  previousRejectionCheckResult: RejectionCheckResultState;
  previousTypoCheckResult: TypoCheckResultState;
  previousLogicCheckResult: LogicCheckResultState;
}

export interface RejectionCheckRunPlan {
  activeCheckResultTab: RejectionCheckResultTab;
  rejectionCheckResult: RejectionCheckResultState;
  typoCheckResult: TypoCheckResultState;
  logicCheckResult: LogicCheckResultState;
  checkTask: RejectionBackgroundTaskState;
}

export interface ExtractionStartPlan {
  extractionState: RejectionExtractionState;
  extractionTask: RejectionBackgroundTaskState;
}

// 勾了废标项就看废标项，否则看错别字，再否则看逻辑谬误。
export function pickActiveCheckResultTab(runOptions: RejectionCheckOptions): RejectionCheckResultTab {
  return runOptions.rejectionCheck ? 'rejection' : runOptions.typoCheck ? 'typo' : 'logic';
}

export function buildExtractionStartPlan(signature: string, startedAt: string, taskId: string): ExtractionStartPlan {
  return {
    extractionState: {
      status: 'running',
      content: '',
      source: 'ai',
      tenderSignature: signature,
      updatedAt: startedAt,
    },
    extractionTask: {
      task_id: taskId,
      type: 'rejection-items-extraction',
      status: 'running',
      progress: 5,
      logs: ['正在启动无效与废标项解析任务。'],
      started_at: startedAt,
      updated_at: startedAt,
    },
  };
}

export function buildExtractionErrorState(signature: string, message: string, updatedAt: string): RejectionExtractionState {
  return {
    status: 'error',
    content: '',
    error: message,
    source: 'ai',
    tenderSignature: signature,
    updatedAt,
  };
}

export function buildCheckRunPlan(input: RejectionCheckRunPlanInput): RejectionCheckRunPlan {
  const {
    runOptions, bidSignature, rejectionInputSignature, startedAt, taskId,
    previousRejectionCheckResult, previousTypoCheckResult, previousLogicCheckResult,
  } = input;

  return {
    activeCheckResultTab: pickActiveCheckResultTab(runOptions),
    rejectionCheckResult: runOptions.rejectionCheck
      ? {
          status: 'running',
          findings: [],
          inputSignature: rejectionInputSignature,
          progressMessage: '第一轮：正在分析检查范围。',
          updatedAt: startedAt,
        }
      : previousRejectionCheckResult,
    typoCheckResult: runOptions.typoCheck
      ? {
          status: 'running',
          findings: [],
          inputSignature: bidSignature,
          progressMessage: '正在识别错别字候选。',
          updatedAt: startedAt,
        }
      : previousTypoCheckResult,
    logicCheckResult: runOptions.logicCheck
      ? {
          status: 'running',
          findings: [],
          inputSignature: bidSignature,
          progressMessage: '正在检查逻辑谬误。',
          updatedAt: startedAt,
        }
      : previousLogicCheckResult,
    checkTask: {
      task_id: taskId,
      type: 'rejection-check-run',
      status: 'running',
      progress: 5,
      logs: ['正在启动检查任务。'],
      started_at: startedAt,
      updated_at: startedAt,
    },
  };
}

// 启动失败时的补丁：只有签名还对得上的结果才改，避免把旧结果写成错误态。
export function markCheckResultFailed<T extends RejectionCheckResultState | TypoCheckResultState | LogicCheckResultState>(
  prev: T,
  message: string,
  signature: string,
  updatedAt: string,
): T {
  return prev.inputSignature === signature
    ? { ...prev, status: 'error', error: message, progressMessage: message, updatedAt }
    : prev;
}

export function markBackgroundTaskFailed(
  prev: RejectionBackgroundTaskState | undefined,
  message: string,
  updatedAt: string,
): RejectionBackgroundTaskState | undefined {
  return prev
    ? { ...prev, status: 'error', progress: 100, error: message, logs: [message], updated_at: updatedAt }
    : prev;
}
