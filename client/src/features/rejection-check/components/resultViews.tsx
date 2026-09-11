// 废标项检查的结果视图：过滤条 + 三类 finding 分组 + 错别字/逻辑谬误结果面板。
//
// 原本是 RejectionCheckPage 里的 7 个 render* 函数（约 200 行）。props 刻意沿用页面里的局部名字，
// 这样 JSX 正文可以逐字搬移；互相调用处改成组件嵌套，调用方从「函数 + 参数」变成「组件 + props」。

import { getBidDocumentLabel, checkRunStatusLabels } from '../model';
import { filterFindingsByActiveBid, groupFindingsByBid } from '../findingModel';
import { LogicFindingItem, RejectionFindingItem, TypoFindingItem } from './findingItems';
import type {
  LogicCheckFinding,
  LogicCheckResultState,
  RejectionCheckFinding,
  RejectionCheckOptions,
  RejectionCheckResultState,
  RejectionCheckResultTab,
  RejectionCheckRunStatus,
  RejectionDocumentContent,
  TypoCheckFinding,
  TypoCheckResultState,
} from '../../../shared/types/domains/rejection-check';

export interface DisabledCheckNoticeProps {
  label: string;
}

export function DisabledCheckNotice({
  label,
}: DisabledCheckNoticeProps) {
    return (
      <div className="markdown-empty-state rejection-finding-empty">
        <strong>{label}已关闭</strong>
        <p>可在右上角检查配置中重新启用。</p>
      </div>
    );
}

export interface BidResultFilterProps {
  bidDocuments: RejectionDocumentContent[];
  activeResultBidDocumentId: string;
  setActiveResultBidDocumentId: (documentId: string) => void;
  findings: Array<{ bidDocumentId: string }>;
}

export function BidResultFilter({
  bidDocuments,
  activeResultBidDocumentId,
  setActiveResultBidDocumentId,
  findings,
}: BidResultFilterProps) {
    const counts = new Map<string, number>();
    findings.forEach((finding) => counts.set(finding.bidDocumentId, (counts.get(finding.bidDocumentId) || 0) + 1));
    return (
      <div className="rejection-bid-result-filter" role="tablist" aria-label="按投标文件筛选结果">
        <button type="button" className={activeResultBidDocumentId === 'all' ? 'is-active' : ''} onClick={() => setActiveResultBidDocumentId('all')}>
          全部 <span>{findings.length}</span>
        </button>
        {bidDocuments.map((document, index) => (
          <button
            type="button"
            key={document.id}
            className={activeResultBidDocumentId === document.id ? 'is-active' : ''}
            onClick={() => setActiveResultBidDocumentId(document.id)}
            title={document.fileName}
          >
            {`投标文件${index + 1}`} <span>{counts.get(document.id) || 0}</span>
          </button>
        ))}
      </div>
    );
}

export interface RejectionFindingGroupsProps {
  bidDocuments: RejectionDocumentContent[];
  activeResultBidDocumentId: string;
  rejectionCheckResult: RejectionCheckResultState;
  toggleFinding: (findingId: string) => void;
  deleteFinding: (findingId: string) => void;
  findings: RejectionCheckFinding[];
}

export function RejectionFindingGroups({
  bidDocuments,
  activeResultBidDocumentId,
  rejectionCheckResult,
  toggleFinding,
  deleteFinding,
  findings,
}: RejectionFindingGroupsProps) {
    const groups = groupFindingsByBid(findings, bidDocuments, activeResultBidDocumentId);
    return (
      <div className="rejection-finding-list">
        {groups.map((group) => (
          <section className="rejection-finding-group" key={group.document.id}>
            {activeResultBidDocumentId === 'all' && (
              <div className="rejection-finding-group-head">
                <strong>{getBidDocumentLabel(bidDocuments, group.document.id)}</strong>
                <span>{group.document.fileName} · {group.findings.length} 个风险项</span>
              </div>
            )}
            {group.findings.map((finding) => (
              <RejectionFindingItem
                key={finding.id}
                finding={finding}
                bidLabel={getBidDocumentLabel(bidDocuments, finding.bidDocumentId)}
                expanded={rejectionCheckResult.activeFindingId === finding.id}
                onToggle={() => toggleFinding(finding.id)}
                onDelete={() => deleteFinding(finding.id)}
              />
            ))}
          </section>
        ))}
      </div>
    );
}

export interface TypoFindingGroupsProps {
  bidDocuments: RejectionDocumentContent[];
  activeResultBidDocumentId: string;
  typoCheckResult: TypoCheckResultState;
  toggleTypoFinding: (findingId: string) => void;
  deleteTypoFinding: (findingId: string) => void;
  copyTypoOriginal: (finding: TypoCheckFinding) => Promise<void>;
  copyTypoWrong: (finding: TypoCheckFinding) => Promise<void>;
  findings: TypoCheckFinding[];
}

export function TypoFindingGroups({
  bidDocuments,
  activeResultBidDocumentId,
  typoCheckResult,
  toggleTypoFinding,
  deleteTypoFinding,
  copyTypoOriginal,
  copyTypoWrong,
  findings,
}: TypoFindingGroupsProps) {
    const groups = groupFindingsByBid(findings, bidDocuments, activeResultBidDocumentId);
    return (
      <div className="rejection-finding-list">
        {groups.map((group) => (
          <section className="rejection-finding-group" key={group.document.id}>
            {activeResultBidDocumentId === 'all' && (
              <div className="rejection-finding-group-head">
                <strong>{getBidDocumentLabel(bidDocuments, group.document.id)}</strong>
                <span>{group.document.fileName} · {group.findings.length} 个错别字</span>
              </div>
            )}
            {group.findings.map((finding) => (
              <TypoFindingItem
                key={finding.id}
                finding={finding}
                bidLabel={getBidDocumentLabel(bidDocuments, finding.bidDocumentId)}
                expanded={typoCheckResult.activeFindingId === finding.id}
                onToggle={() => toggleTypoFinding(finding.id)}
                onDelete={() => deleteTypoFinding(finding.id)}
                onCopyOriginal={() => void copyTypoOriginal(finding)}
                onCopyWrong={() => void copyTypoWrong(finding)}
              />
            ))}
          </section>
        ))}
      </div>
    );
}

export interface LogicFindingGroupsProps {
  bidDocuments: RejectionDocumentContent[];
  activeResultBidDocumentId: string;
  logicCheckResult: LogicCheckResultState;
  toggleLogicFinding: (findingId: string) => void;
  deleteLogicFinding: (findingId: string) => void;
  findings: LogicCheckFinding[];
}

export function LogicFindingGroups({
  bidDocuments,
  activeResultBidDocumentId,
  logicCheckResult,
  toggleLogicFinding,
  deleteLogicFinding,
  findings,
}: LogicFindingGroupsProps) {
    const groups = groupFindingsByBid(findings, bidDocuments, activeResultBidDocumentId);
    return (
      <div className="rejection-finding-list">
        {groups.map((group) => (
          <section className="rejection-finding-group" key={group.document.id}>
            {activeResultBidDocumentId === 'all' && (
              <div className="rejection-finding-group-head">
                <strong>{getBidDocumentLabel(bidDocuments, group.document.id)}</strong>
                <span>{group.document.fileName} · {group.findings.length} 个逻辑问题</span>
              </div>
            )}
            {group.findings.map((finding) => (
              <LogicFindingItem
                key={finding.id}
                finding={finding}
                bidLabel={getBidDocumentLabel(bidDocuments, finding.bidDocumentId)}
                expanded={logicCheckResult.activeFindingId === finding.id}
                onToggle={() => toggleLogicFinding(finding.id)}
                onDelete={() => deleteLogicFinding(finding.id)}
              />
            ))}
          </section>
        ))}
      </div>
    );
}

export interface TypoCheckContentProps {
  checkOptions: RejectionCheckOptions;
  visibleTypoCheckStatus: RejectionCheckRunStatus;
  typoCheckSummaryText: string;
  visibleTypoFindings: TypoCheckFinding[];
  typoCheckResult: TypoCheckResultState;
  bidDocuments: RejectionDocumentContent[];
  activeResultBidDocumentId: string;
  setActiveResultBidDocumentId: (documentId: string) => void;
  checkRunning: boolean;
  extractionRunning: boolean;
  retrySingleCheck: (tabId: RejectionCheckResultTab) => void;
  hasStaleTypoCheckResult: boolean;
  toggleTypoFinding: (findingId: string) => void;
  deleteTypoFinding: (findingId: string) => void;
  copyTypoOriginal: (finding: TypoCheckFinding) => Promise<void>;
  copyTypoWrong: (finding: TypoCheckFinding) => Promise<void>;
}

export function TypoCheckContent({
  checkOptions,
  visibleTypoCheckStatus,
  typoCheckSummaryText,
  visibleTypoFindings,
  typoCheckResult,
  bidDocuments,
  activeResultBidDocumentId,
  setActiveResultBidDocumentId,
  checkRunning,
  extractionRunning,
  retrySingleCheck,
  hasStaleTypoCheckResult,
  toggleTypoFinding,
  deleteTypoFinding,
  copyTypoOriginal,
  copyTypoWrong,
}: TypoCheckContentProps) {
    if (!checkOptions.typoCheck) {
      return <DisabledCheckNotice label="错别字检查" />;
    }

    return (
      <>
        <div className="rejection-finding-summary">
          <div>
            <span className="section-kicker">错别字检查</span>
            <h3>{visibleTypoCheckStatus === 'running' ? '正在检查错别字' : '错别字检查结果'}</h3>
            <p>{typoCheckSummaryText}</p>
          </div>
          <div className={`rejection-result-status is-${visibleTypoCheckStatus}`}>
            <span>{checkRunStatusLabels[visibleTypoCheckStatus]}</span>
            <small>{visibleTypoCheckStatus === 'success' ? `${visibleTypoFindings.length} 个错别字` : typoCheckResult.progressMessage || '等待执行'}</small>
          </div>
        </div>
        <BidResultFilter bidDocuments={bidDocuments} activeResultBidDocumentId={activeResultBidDocumentId} setActiveResultBidDocumentId={setActiveResultBidDocumentId} findings={visibleTypoFindings} />

        {visibleTypoCheckStatus === 'running' ? (
          <div className="markdown-empty-state rejection-finding-empty">
            <strong>AI 正在检查错别字</strong>
            <p>{typoCheckResult.progressMessage || '正在识别候选并校验原文位置。'}</p>
          </div>
        ) : visibleTypoCheckStatus === 'error' ? (
          <div className="markdown-empty-state rejection-finding-empty is-error">
            <strong>{typoCheckResult.error || '错别字检查失败'}</strong>
            <p>请确认模型配置可用，或重新检查当前投标文件。</p>
            <button type="button" className="secondary-action" onClick={() => retrySingleCheck('typo')} disabled={checkRunning || extractionRunning || !bidDocuments.length}>
              重新检查错别字
            </button>
          </div>
        ) : filterFindingsByActiveBid(visibleTypoFindings, activeResultBidDocumentId).length ? (
          <TypoFindingGroups bidDocuments={bidDocuments} activeResultBidDocumentId={activeResultBidDocumentId} typoCheckResult={typoCheckResult} toggleTypoFinding={toggleTypoFinding} deleteTypoFinding={deleteTypoFinding} copyTypoOriginal={copyTypoOriginal} copyTypoWrong={copyTypoWrong} findings={visibleTypoFindings} />
        ) : (
          <div className="markdown-empty-state rejection-finding-empty">
            <strong>{visibleTypoCheckStatus === 'success' ? '暂未发现错别字' : hasStaleTypoCheckResult ? '投标文件已变化' : '等待错别字检查'}</strong>
            <p>{typoCheckSummaryText}</p>
          </div>
        )}
      </>
    );
}

export interface LogicCheckContentProps {
  checkOptions: RejectionCheckOptions;
  visibleLogicCheckStatus: RejectionCheckRunStatus;
  logicCheckSummaryText: string;
  visibleLogicFindings: LogicCheckFinding[];
  logicCheckResult: LogicCheckResultState;
  bidDocuments: RejectionDocumentContent[];
  activeResultBidDocumentId: string;
  setActiveResultBidDocumentId: (documentId: string) => void;
  checkRunning: boolean;
  extractionRunning: boolean;
  retrySingleCheck: (tabId: RejectionCheckResultTab) => void;
  hasStaleLogicCheckResult: boolean;
  toggleLogicFinding: (findingId: string) => void;
  deleteLogicFinding: (findingId: string) => void;
}

export function LogicCheckContent({
  checkOptions,
  visibleLogicCheckStatus,
  logicCheckSummaryText,
  visibleLogicFindings,
  logicCheckResult,
  bidDocuments,
  activeResultBidDocumentId,
  setActiveResultBidDocumentId,
  checkRunning,
  extractionRunning,
  retrySingleCheck,
  hasStaleLogicCheckResult,
  toggleLogicFinding,
  deleteLogicFinding,
}: LogicCheckContentProps) {
    if (!checkOptions.logicCheck) {
      return <DisabledCheckNotice label="逻辑谬误检查" />;
    }

    return (
      <>
        <div className="rejection-finding-summary">
          <div>
            <span className="section-kicker">逻辑谬误检查</span>
            <h3>{visibleLogicCheckStatus === 'running' ? '正在检查逻辑谬误' : '逻辑谬误检查结果'}</h3>
            <p>{logicCheckSummaryText}</p>
          </div>
          <div className={`rejection-result-status is-${visibleLogicCheckStatus}`}>
            <span>{checkRunStatusLabels[visibleLogicCheckStatus]}</span>
            <small>{visibleLogicCheckStatus === 'success' ? `${visibleLogicFindings.length} 个逻辑问题` : logicCheckResult.progressMessage || '等待执行'}</small>
          </div>
        </div>
        <BidResultFilter bidDocuments={bidDocuments} activeResultBidDocumentId={activeResultBidDocumentId} setActiveResultBidDocumentId={setActiveResultBidDocumentId} findings={visibleLogicFindings} />

        {visibleLogicCheckStatus === 'running' ? (
          <div className="markdown-empty-state rejection-finding-empty">
            <strong>AI 正在检查逻辑谬误</strong>
            <p>{logicCheckResult.progressMessage || '正在检查句子逻辑漏洞和全文前后不一致。'}</p>
          </div>
        ) : visibleLogicCheckStatus === 'error' ? (
          <div className="markdown-empty-state rejection-finding-empty is-error">
            <strong>{logicCheckResult.error || '逻辑谬误检查失败'}</strong>
            <p>请确认模型配置可用，或重新检查当前投标文件。</p>
            <button type="button" className="secondary-action" onClick={() => retrySingleCheck('logic')} disabled={checkRunning || extractionRunning || !bidDocuments.length}>
              重新检查逻辑谬误
            </button>
          </div>
        ) : filterFindingsByActiveBid(visibleLogicFindings, activeResultBidDocumentId).length ? (
          <LogicFindingGroups bidDocuments={bidDocuments} activeResultBidDocumentId={activeResultBidDocumentId} logicCheckResult={logicCheckResult} toggleLogicFinding={toggleLogicFinding} deleteLogicFinding={deleteLogicFinding} findings={visibleLogicFindings} />
        ) : (
          <div className="markdown-empty-state rejection-finding-empty">
            <strong>{visibleLogicCheckStatus === 'success' ? '暂未发现逻辑谬误' : hasStaleLogicCheckResult ? '投标文件已变化' : '等待逻辑谬误检查'}</strong>
            <p>{logicCheckSummaryText}</p>
          </div>
        )}
      </>
    );
}
