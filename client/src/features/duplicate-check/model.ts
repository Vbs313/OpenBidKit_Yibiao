// 标书查重的纯模型层：展示标签、格式化与查重签名。
//
// 原本散在 DuplicateCheckPage.tsx 顶部，被页面与各分析面板共用。

import type { DuplicateAnalysisStatus, DuplicateAnalysisTabId, LocalFileSelection } from '../../shared/types';

const analysisTabs: Array<{
  id: DuplicateAnalysisTabId;
  label: string;
}> = [
  { id: 'metadata', label: '元数据' },
  { id: 'outline', label: '目录' },
  { id: 'content', label: '正文' },
  { id: 'image', label: '图片' },
];

function formatFileSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('zh-CN', { hour12: false });
}

function statusLabel(status: DuplicateAnalysisStatus) {
  if (status === 'running') return '分析中';
  if (status === 'success') return '已完成';
  if (status === 'error') return '有错误';
  return '待分析';
}

function progressText(progress?: { completed: number; total: number }) {
  if (!progress?.total) return '0/0';
  return `${progress.completed}/${progress.total}`;
}

function fileIndexLabel(index: number) {
  let value = index;
  let label = '';
  do {
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return label;
}

function buildFileLabelMap(files: LocalFileSelection[]) {
  return new Map(files.map((file, index) => [file.id, fileIndexLabel(index)]));
}

function formatDuplicateSentenceText(normalized: string, sentence: string) {
  const text = normalized || sentence;
  return text.length > 600 ? `${text.slice(0, 600)}...` : text;
}

function formatImageLocationSentence(value: string) {
  return value.length > 72 ? `${value.slice(0, 72)}...` : value;
}

function createDuplicateCheckSignature(files: LocalFileSelection[]) {
  const source = files
    .map((file) => `${file.file_path}|${file.size}|${file.modified_at}`)
    .join('\n');
  const bytes = new TextEncoder().encode(source);
  const words = new Uint32Array(80);
  const paddedLength = (((bytes.length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const bitLength = bytes.length * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 4, bitLength, false);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 80; index += 1) {
      words[index] = rotateLeft(words[index - 3] ^ words[index - 8] ^ words[index - 14] ^ words[index - 16], 1);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let index = 0; index < 80; index += 1) {
      let f = 0;
      let k = 0;
      if (index < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (index < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (index < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }

      const temp = (rotateLeft(a, 5) + f + e + k + words[index]) >>> 0;
      e = d;
      d = c;
      c = rotateLeft(b, 30);
      b = a;
      a = temp;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  return [h0, h1, h2, h3, h4].map((value) => value.toString(16).padStart(8, '0')).join('');
}

function rotateLeft(value: number, bits: number) {
  return (value << bits) | (value >>> (32 - bits));
}

export {
  analysisTabs,
  formatFileSize,
  formatDate,
  statusLabel,
  progressText,
  fileIndexLabel,
  buildFileLabelMap,
  formatDuplicateSentenceText,
  formatImageLocationSentence,
  createDuplicateCheckSignature,
  rotateLeft,
};
