// 知识库页面的纯展示模型：视图类型与可打开/可移动判断。
//
// 原本散在 KnowledgeBasePage.tsx 顶部，被页面与展示组件共用。

import type { KnowledgeDocument } from '../../shared/types/domains/knowledge-base';

type KnowledgeViewer = {
  document: KnowledgeDocument;
  mode: 'analysis' | 'items' | 'markdown';
  targetItemId?: string;
};

function formatInteger(value?: number) {
  return typeof value === 'number' ? value.toLocaleString('zh-CN') : '-';
}

function formatPercent(value?: number) {
  return typeof value === 'number' ? `${Math.round(value * 100)}%` : '-';
}

function canOpenAnalysis(document: KnowledgeDocument) {
  return !['pending', 'copying', 'converting', 'extracting'].includes(document.status);
}

function canOpenMarkdown(document: KnowledgeDocument) {
  return !['pending', 'copying'].includes(document.status);
}

function canMoveKnowledgeDocument(document: KnowledgeDocument) {
  return ['ready_for_matching', 'success', 'error'].includes(document.status);
}

function mergeDocuments(prev: KnowledgeDocument[], next: KnowledgeDocument[]) {
  const byId = new Map(prev.map((document) => [document.id, document]));
  next.forEach((document) => byId.set(document.id, document));
  return Array.from(byId.values());
}

export type KnowledgeDropPosition = 'before' | 'after';
export type KnowledgeDragPayload =
  | { kind: 'folder'; folderId: string }
  | { kind: 'document'; documentId: string; folderId: string };

export interface KnowledgeDocumentDropTarget {
  documentId: string;
  position: KnowledgeDropPosition;
}

export type {
  KnowledgeViewer,
};

export {
  formatInteger,
  formatPercent,
  canOpenAnalysis,
  canOpenMarkdown,
  canMoveKnowledgeDocument,
  mergeDocuments,
};
