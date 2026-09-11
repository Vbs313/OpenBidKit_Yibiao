import * as Popover from '@radix-ui/react-popover';
import type { CSSProperties, ReactNode } from 'react';
import { OUTLINE_CONTENT_MODE_LABELS } from '../../../shared/types';
import type { OutlineItem } from '../../../shared/types';
import type { ExportFormatConfig } from '../../../shared/types/exportFormat';
import { formatOutlineTitle } from '../../../shared/utils/outlineNumbering';
import type { OutlineNodeMeta } from '../contentEditModel';
import { statusLabels } from '../contentEditModel';

interface ContentOutlineTreeProps {
  items: OutlineItem[];
  outlineMeta: Map<string, OutlineNodeMeta>;
  selectedItemId: string;
  exportFormat: ExportFormatConfig;
  taskBlocksGeneration: boolean;
  confirmRegenerateItem: OutlineItem | null;
  onSelectItem: (itemId: string) => void;
  onRegenerateItemChange: (item: OutlineItem | null) => void;
  onRequestRequirement: (item: OutlineItem) => void;
}

// 正文目录树：从 ContentEditPage 原样搬出的递归渲染（含「重新生成此小节」气泡）与状态标签。
export function ContentOutlineTree({
  items,
  outlineMeta,
  selectedItemId,
  exportFormat,
  taskBlocksGeneration,
  confirmRegenerateItem,
  onSelectItem,
  onRegenerateItemChange,
  onRequestRequirement,
}: ContentOutlineTreeProps) {
  const renderTree = (items: OutlineItem[], level = 0): ReactNode => items.map((item) => {
    const meta = outlineMeta.get(item.id);
    const status = meta?.status || 'idle';
    const isLeaf = !item.children?.length;
    const leafCount = meta?.leafCount || 0;
    const words = meta?.words || 0;
    const modeLabel = isLeaf && item.content_mode ? OUTLINE_CONTENT_MODE_LABELS[item.content_mode] : '';

    return (
      <div className="content-outline-node" key={item.id} style={{ '--content-level': level } as CSSProperties}>
        <button
          type="button"
          className={`content-outline-item is-${status}${selectedItemId === item.id ? ' is-active' : ''}`}
          onClick={() => onSelectItem(item.id)}
        >
          <span className="content-outline-dot" aria-hidden="true" />
          <span className="content-outline-text">
            <strong>{formatOutlineTitle(item.id, item.title, exportFormat.headings[Math.min(item.id.split('.').length - 1, 5)])}</strong>
            <small>{isLeaf ? `${modeLabel || '未标记'} · ${statusLabels[status]} · ${words} 字` : `${statusLabels[status]} · ${leafCount} 个小节 · ${words} 字`}</small>
          </span>
          {isLeaf && item.content_mode === 'ai-generate' && (status === 'success' || status === 'error') ? (
            <Popover.Root
              open={confirmRegenerateItem?.id === item.id}
              onOpenChange={(open) => onRegenerateItemChange(open ? item : null)}
            >
              <Popover.Trigger asChild>
                <em
                  className="is-clickable"
                  onClick={(event) => {
                    event.stopPropagation();
                  }}
                >{statusLabels[status]}</em>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content className="content-regenerate-popover" side="top" align="end" sideOffset={8}>
                  <strong>重新生成此小节？</strong>
                  <span>{status === 'error' ? '将重新尝试生成失败的小节。' : '将覆盖当前正文内容。'}</span>
                  <div>
                    <button
                      type="button"
                      className="primary-action"
                      disabled={taskBlocksGeneration}
                      onClick={() => {
                        onRequestRequirement(item);
                        onRegenerateItemChange(null);
                      }}
                    >是</button>
                    <Popover.Close className="secondary-action" type="button">否</Popover.Close>
                  </div>
                  <Popover.Arrow className="content-regenerate-popover-arrow" />
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          ) : (
            <em>{statusLabels[status]}</em>
          )}
        </button>
        {item.children?.length ? renderTree(item.children, level + 1) : null}
      </div>
    );
  });

  return <>{renderTree(items)}</>;
}
