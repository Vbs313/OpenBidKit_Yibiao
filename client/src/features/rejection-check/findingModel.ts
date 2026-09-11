// 结果项的纯逻辑：展开/收起、删除、按投标文件过滤与分组。
//
// 从 RejectionCheckPage 抽出来的三件事：
//   1) 三类检查结果（废标项 / 错别字 / 逻辑）用同一套形状，增删改却各写了一遍；
//   2) 删除后要同时改 findings / activeFindingId / progressMessage，漏一个就会留下脏状态；
//   3) 「按投标文件筛选」的分组逻辑夹在渲染函数里，没法单测。
// 时间戳仍然由调用方注入，函数保持纯。

import type { RejectionDocumentContent } from '../../shared/types/domains/rejection-check';

export interface FindingLike {
  id: string;
  bidDocumentId: string;
}

export interface FindingResultLike {
  findings: FindingLike[];
  activeFindingId?: string;
  progressMessage?: string;
}

// 展开/收起：点同一条就收起，点别的就切过去。
export function toggleResultFinding<T extends { activeFindingId?: string }>(
  result: T,
  findingId: string,
  updatedAt: string,
): T {
  return {
    ...result,
    activeFindingId: result.activeFindingId === findingId ? undefined : findingId,
    updatedAt,
  };
}

// 删除结果项：过滤 + 「删的就是当前展开项」时收起 + 进度文案。
// keepLabel / doneLabel 分开传，是因为三类结果的文案不对称：
// 「保留 3 个需复核风险项」 ≠ 「所有需复核风险项已处理」，后者是「所有风险项已处理」。
export function deleteResultFinding<T extends FindingResultLike>(
  result: T,
  findingId: string,
  updatedAt: string,
  keepLabel: string,
  doneLabel: string,
): T {
  const findings = result.findings.filter((item) => item.id !== findingId);
  return {
    ...result,
    findings,
    activeFindingId: result.activeFindingId === findingId ? undefined : result.activeFindingId,
    progressMessage: findings.length ? `保留 ${findings.length} 个${keepLabel}` : `所有${doneLabel}已处理`,
    updatedAt,
  };
}

export function filterFindingsByActiveBid<T extends { bidDocumentId: string }>(
  findings: T[],
  activeBidDocumentId: string,
): T[] {
  return activeBidDocumentId === 'all'
    ? findings
    : findings.filter((finding) => finding.bidDocumentId === activeBidDocumentId);
}

export function groupFindingsByBid<T extends { bidDocumentId: string }>(
  findings: T[],
  bidDocuments: RejectionDocumentContent[],
  activeBidDocumentId: string,
): Array<{ document: RejectionDocumentContent; findings: T[] }> {
  const filteredFindings = filterFindingsByActiveBid(findings, activeBidDocumentId);
  if (activeBidDocumentId !== 'all') {
    const document = bidDocuments.find((item) => item.id === activeBidDocumentId);
    return document ? [{ document, findings: filteredFindings }] : [];
  }
  return bidDocuments
    .map((document) => ({
      document,
      findings: filteredFindings.filter((finding) => finding.bidDocumentId === document.id),
    }))
    .filter((group) => group.findings.length > 0);
}
