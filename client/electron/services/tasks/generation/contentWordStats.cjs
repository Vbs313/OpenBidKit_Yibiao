// 正文可读字数统计：维护每小节字数索引与全文累计字数，并产出进度统计快照。
// 该簇原本是 runContentGenerationTask 内部的闭包；这里把可变状态与读取入口
// 改成由 createContentWordStats(deps) 显式注入，自身不持有模块级状态。
//
// deps 约定：
//   contentStats / wordControl / contentWordCounts / generationCompletedItemIds
//     直接读写的对象（Map / Set 就地修改）
//   getLeaves() / getSections()                读取会被重新赋值的闭包变量
//   getTotalContentWords() / setTotalContentWords(value)
//                                              读写会被重新赋值的全文字数累计
// 工厂返回的函数集合就是原先的一组闭包函数。

const { countContentWords } = require('./aiCallContext.cjs');

function createContentWordStats(deps) {
  const {
    contentStats,
    wordControl,
    contentWordCounts,
    generationCompletedItemIds,
    getLeaves,
    getSections,
    getTotalContentWords,
    setTotalContentWords,
  } = deps;

  function getLeafContentForWords(item) {
    const section = getSections()[item.id];
    if (section?.status === 'ignored') return '';
    return section && Object.prototype.hasOwnProperty.call(section, 'content')
      ? section.content || ''
      : item.content || '';
  }

  // 更新单个小节字数及全文累计字数。
  function updateContentWordCount(itemId, content) {
    const previousWords = contentWordCounts.get(itemId) || 0;
    const nextWords = countContentWords(content);
    contentWordCounts.set(itemId, nextWords);
    setTotalContentWords(getTotalContentWords() + nextWords - previousWords);
    return nextWords;
  }

  // 正文整体替换后重建内存字数索引。
  function rebuildContentWordCounts() {
    contentWordCounts.clear();
    setTotalContentWords(0);
    for (const { item } of getLeaves()) {
      updateContentWordCount(item.id, getLeafContentForWords(item));
    }
  }

  function getLeafWordCount(item) {
    return contentWordCounts.get(item.id) || 0;
  }

  function countTotalContentWords() {
    return getTotalContentWords();
  }

  function leafWordStats() {
    return getLeaves().map((context) => ({
      ...context,
      content: getLeafContentForWords(context.item),
      words: getLeafWordCount(context.item),
    }));
  }

  function statsSnapshot() {
    contentStats.generation_completed = generationCompletedItemIds.size;
    contentStats.current_words = countTotalContentWords();
    contentStats.minimum_words = wordControl.minimumWords;
    contentStats.maximum_words = wordControl.maximumWords;
    contentStats.section_words = wordControl.sectionWords;
    contentStats.strict_section_words = wordControl.strictSectionWords;
    contentStats.ignored_section_count = getLeaves().filter(({ item }) => getSections()[item.id]?.status === 'ignored').length;
    return { content: { ...contentStats } };
  }

  rebuildContentWordCounts();

  return {
    getLeafContentForWords,
    updateContentWordCount,
    rebuildContentWordCounts,
    getLeafWordCount,
    countTotalContentWords,
    leafWordStats,
    statsSnapshot,
  };
}

module.exports = { createContentWordStats };