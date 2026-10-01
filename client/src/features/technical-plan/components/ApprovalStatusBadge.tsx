import { useState } from 'react';
import { AppDialog, useToast } from '../../../shared/ui';

type ApprovalStatus = 'pending' | 'approved' | 'rejected';

const STATUS_META: Record<ApprovalStatus, { label: string; className: string }> = {
  pending: { label: '待审批', className: 'is-pending' },
  approved: { label: '已审批', className: 'is-approved' },
  rejected: { label: '已驳回', className: 'is-rejected' },
};

interface ApprovalStatusBadgeProps {
  status: ApprovalStatus;
  comment?: string;
  updatedAt?: string;
  onSave: (payload: { status: ApprovalStatus; comment?: string }) => Promise<unknown>;
}

/**
 * 审批状态徽章 + 审批操作入口。
 * 显示当前审批状态（待审/已审/驳回），点击可打开审批对话框。
 */
export default function ApprovalStatusBadge({ status, comment, updatedAt, onSave }: ApprovalStatusBadgeProps) {
  const [open, setOpen] = useState(false);
  const [draftStatus, setDraftStatus] = useState<ApprovalStatus>(status);
  const [draftComment, setDraftComment] = useState(comment || '');
  const { showToast } = useToast();
  const meta = STATUS_META[status] || STATUS_META.pending;

  const handleSave = async () => {
    try {
      await onSave({ status: draftStatus, comment: draftComment.trim() || undefined });
      setOpen(false);
      showToast(`审批状态已更新为「${STATUS_META[draftStatus].label}」`, 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存审批状态失败', 'error');
    }
  };

  return (
    <>
      <button
        type="button"
        className={`approval-status-badge ${meta.className}`}
        onClick={() => {
          setDraftStatus(status);
          setDraftComment(comment || '');
          setOpen(true);
        }}
        title={comment || '点击设置审批状态'}
      >
        {meta.label}
      </button>
      <AppDialog
        open={open}
        onOpenChange={setOpen}
        kicker="审批流"
        title="设置审批状态"
        description={updatedAt ? `上次更新：${updatedAt}` : undefined}
        actions={
          <>
            <button type="button" className="secondary-action" onClick={() => setOpen(false)}>取消</button>
            <button type="button" className="primary-action" onClick={() => void handleSave()}>保存</button>
          </>
        }
      >
        <div className="approval-dialog">
          <div className="approval-status-options" role="radiogroup" aria-label="审批状态">
            {(Object.keys(STATUS_META) as ApprovalStatus[]).map((key) => (
              <button
                key={key}
                type="button"
                className={`approval-status-option${draftStatus === key ? ' is-selected' : ''}`}
                onClick={() => setDraftStatus(key)}
                role="radio"
                aria-checked={draftStatus === key}
              >
                {STATUS_META[key].label}
              </button>
            ))}
          </div>
          <label className="approval-comment-label">
            <span>审批意见</span>
            <textarea
              value={draftComment}
              onChange={(event) => setDraftComment(event.target.value)}
              placeholder="可填写审批意见（最多 2000 字）"
              rows={4}
              maxLength={2000}
            />
          </label>
        </div>
      </AppDialog>
    </>
  );
}
