// 标书解析（BidAnalysisPage）的纯模型：解析项分组、模式判定、JSON 结果解析与字段中文名。
//
// 原本是 BidAnalysisPage.tsx 顶部的 170 行模块级代码。抽出来后可单测：
// 「关键项必选 + 自定义勾选」的归一化、模式回推（key/custom/full）、JSON 文本 → 对象。

import { bidAnalysisTasks, getBidAnalysisTasks } from './services/bidAnalysisWorkflow';
import type { BidAnalysisMode, BidAnalysisTaskState } from '../../shared/types/domains/technical-plan';

export const modeOptions: Array<{ id: 'key' | 'full'; title: string; badge: string }> = [
  {
    id: 'key',
    title: '只解析关键项',
    badge: '默认',
  },
  {
    id: 'full',
    title: '完整解析',
    badge: '更多 Token',
  },
];

export const allBidAnalysisTaskIds = bidAnalysisTasks.map((task) => task.id);
export const requiredBidAnalysisTaskIds = getBidAnalysisTasks('key').map((task) => task.id);
export const requiredBidAnalysisTaskIdSet = new Set(requiredBidAnalysisTaskIds);

export function normalizeSelectedTaskIds(taskIds: string[]) {
  const requestedIds = new Set(taskIds);
  return allBidAnalysisTaskIds.filter((taskId) => requiredBidAnalysisTaskIdSet.has(taskId) || requestedIds.has(taskId));
}

export function getSelectedTaskIdsForMode(mode: BidAnalysisMode, taskIds: string[]) {
  if (mode === 'full') {
    return allBidAnalysisTaskIds;
  }
  if (mode === 'custom') {
    return normalizeSelectedTaskIds(taskIds);
  }
  return requiredBidAnalysisTaskIds;
}

export function getModeForSelection(taskIds: string[]): BidAnalysisMode {
  const selectedIds = normalizeSelectedTaskIds(taskIds);
  if (selectedIds.length === allBidAnalysisTaskIds.length) {
    return 'full';
  }
  if (selectedIds.some((taskId) => !requiredBidAnalysisTaskIdSet.has(taskId))) {
    return 'custom';
  }
  return 'key';
}

export function getModeLabel(mode: BidAnalysisMode) {
  if (mode === 'full') return '完整解析';
  if (mode === 'custom') return '自定义解析';
  return '只解析关键项';
}

export const taskGroups = [
  { title: '关键项', ids: ['projectOverview', 'techRequirements', 'projectInfo', 'partAInfo', 'deliveryAndServiceRequirements', 'responseFileRequirements'] },
  { title: '采购项', ids: ['procurementList'] },
  { title: '投标流程', ids: ['keyInfo', 'marginInfo', 'openBid'] },
  { title: '评审要求', ids: ['qualificationReview', 'complianceCheck', 'evaluationBid', 'businessScoring'] },
  { title: '主体与合同', ids: ['agentInfo', 'discardedBids', 'signingProcess', 'terminationCondition'] },
];

export const statusLabel: Record<BidAnalysisTaskState['status'], string> = {
  idle: '待解析',
  running: '解析中',
  success: '已完成',
  error: '失败',
};

export const jsonFieldLabels: Record<string, string> = {
  project_name: '项目名称',
  project_number: '项目编号',
  project_type: '项目类型',
  project_budget: '项目预算',
  project_address: '项目地址',
  company_name: '公司名称',
  address: '地址',
  contact_person: '联系人',
  contact_phone: '联系电话',
  email: '联系邮箱',
  bank_account_name: '银行账户名称',
  bank_account_number: '银行账户账号',
  bank_account_address: '银行账户开户行',
  bank_account_address_detail: '银行账户开户行地址',
  bid_announcement_time: '招标公告发布日期',
  bid_file_get_way: '招标文件获取方式',
  bid_file_price: '招标文件售价',
  get_bid_file_time: '获取招标文件时间',
  bid_document_submission_location: '投标文件提交地点',
  bid_submission_deadline: '投标截止时间',
  bid_opening_time: '开标时间',
  bid_opening_address: '开标地点',
  other_notes: '其他注意事项',
  bidding_deposit: '投标保证金',
  payment_method: '缴纳方式',
  due_date: '截止日期',
  refund_conditions: '退还条件',
  non_refundable_conditions: '不予退还的情形',
  time_place: '时间地点',
  part_req: '参与要求',
  invalid_bid: '无效标认定',
  objection: '异议处理',
  bid_process: '开标流程',
  committee: '评标委员会组成',
  duties: '评标委员会职责',
  scoring: '评分构成',
  method: '评标方法类型',
  principles: '评标原则和方法细节',
  others: '其他信息',
  bid_notice: '中标公示',
  contract_sign: '合同签订',
  performance_bond: '履约保证金',
  contract_text: '合同文本',
  breach_termination: '违约解除',
  force_majeure: '不可抗力',
  contract_termination: '合同终止',
  dispute_resolution: '争议解决',
  implementation_period: '实施周期/工期/交付期限',
  delivery_scope: '交付范围',
  delivery_location: '交付/实施地点',
  acceptance_requirements: '验收要求',
  warranty_period: '质保期',
  after_sales_service: '售后服务要求',
  response_time: '响应时限',
  training_requirements: '培训要求',
  documentation_requirements: '资料/文档交付要求',
};

export function tryParseJsonObject(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function formatJsonValue(value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return '没有提及';
  }

  if (typeof value === 'object') {
    return JSON.stringify(value, null, 2);
  }

  return String(value);
}
