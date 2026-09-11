// 知识库的全库检索：关键词、结果分页、错误与加载态，以及从检索结果跳回文档条目。
//
// 原本是 KnowledgeBasePage 里的 5 个 state + 1 个 ref + 4 个 handler（约 60 行）。
// 用递增 requestId 丢弃过期响应——这个不变式随 hook 一起搬走。
//
// 注入三件事：index（在本地索引里找文档）、setActiveFolderId（切到结果所在文件夹）、openDocument（打开条目）。

import { useRef, useState } from 'react';
import { useToast } from '../../../shared/ui';
import type { KnowledgeBaseIndex, KnowledgeBaseSearchPage, KnowledgeBaseSearchResult, KnowledgeDocument } from '../../../shared/types/domains/knowledge-base';

export interface UseKnowledgeSearchOptions {
  index: KnowledgeBaseIndex;
  setActiveFolderId: (folderId: string) => void;
  openDocument: (document: KnowledgeDocument, mode: 'analysis' | 'items' | 'markdown', targetItemId?: string) => Promise<void>;
}

export function useKnowledgeSearch({ index, setActiveFolderId, openDocument }: UseKnowledgeSearchOptions) {
  const { showToast } = useToast();
  const [searchKeyword, setSearchKeyword] = useState('');
  const [submittedSearchKeyword, setSubmittedSearchKeyword] = useState('');
  const [searchPage, setSearchPage] = useState<KnowledgeBaseSearchPage | null>(null);
  const [searchError, setSearchError] = useState('');
  const [searchLoading, setSearchLoading] = useState(false);
  const searchRequestIdRef = useRef(0);

  const fetchGlobalSearch = async (keyword: string, page: number) => {
    const requestId = ++searchRequestIdRef.current;
    setSearchError('');
    setSearchLoading(true);
    try {
      const result = await window.yibiao.knowledgeBase.search({ keyword, page });
      if (searchRequestIdRef.current !== requestId) return;
      setSearchPage(result);
    } catch (error) {
      if (searchRequestIdRef.current === requestId) {
        const message = error instanceof Error ? error.message : '知识库检索失败';
        setSearchError(message);
        showToast(message, 'error');
      }
    } finally {
      if (searchRequestIdRef.current === requestId) setSearchLoading(false);
    }
  };

  const runGlobalSearch = async () => {
    const keyword = searchKeyword.trim();
    if (!keyword) {
      clearGlobalSearch();
      return;
    }
    setSubmittedSearchKeyword(keyword);
    setSearchPage(null);
    await fetchGlobalSearch(keyword, 1);
  };

  const clearGlobalSearch = () => {
    searchRequestIdRef.current += 1;
    setSearchKeyword('');
    setSubmittedSearchKeyword('');
    setSearchPage(null);
    setSearchError('');
    setSearchLoading(false);
  };

  const openSearchResult = async (result: KnowledgeBaseSearchResult) => {
    const document = index.documents.find((item) => item.id === result.document_id);
    if (!document) {
      showToast('对应知识文档已不存在，请重新检索', 'info');
      return;
    }
    setActiveFolderId(result.folder_id);
    await openDocument(document, 'items', result.item_id);
  };

  return {
    fetchGlobalSearch,
    searchKeyword,
    setSearchKeyword,
    submittedSearchKeyword,
    searchPage,
    searchError,
    searchLoading,
    runGlobalSearch,
    clearGlobalSearch,
    openSearchResult,
  };
}
