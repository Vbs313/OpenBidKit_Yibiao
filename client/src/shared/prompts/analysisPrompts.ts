import catalog from './bidAnalysisTasks.json';

const discardedBidsPrompt = (): string => {
  const task = (catalog.tasks || []).find((item) => item.id === 'discardedBids');
  return task?.prompt || '';
};

/** 与 Main 侧 bidAnalysisCatalog 共用 JSON 目录，避免提示词双源漂移 */
export function buildInvalidBidAndRejectionItemsPrompt() {
  return discardedBidsPrompt();
}
