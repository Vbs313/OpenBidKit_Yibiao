// 文本相似度与风险打分：纯计算，可单独测试。

function intersectSize(a, b) {
  let count = 0;
  for (const item of a) if (b.has(item)) count += 1;
  return count;
}

function lcsSimilarity(left, right) {
  if (!left.length || !right.length) return 0;
  const dp = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      dp[i][j] = left[i - 1] === right[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[left.length][right.length] / Math.max(left.length, right.length);
}

function riskFromScore(score) {
  if (score >= 0.75) return 'high';
  if (score >= 0.55) return 'medium';
  if (score >= 0.35) return 'low';
  return 'none';
}

function charBigramsFromLooseText(value) {
  const text = String(value || '');
  if (!text) return new Set();
  if (text.length === 1) return new Set([text]);
  const grams = new Set();
  for (let index = 0; index < text.length - 1; index += 1) grams.add(text.slice(index, index + 2));
  return grams;
}

function diceSimilarityFromShared(shared, leftSize, rightSize) {
  return (2 * shared) / Math.max(leftSize + rightSize, 1);
}

module.exports = {
  intersectSize,
  lcsSimilarity,
  riskFromScore,
  charBigramsFromLooseText,
  diceSimilarityFromShared,
};
