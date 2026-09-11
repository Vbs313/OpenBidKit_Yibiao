// 解析结果的 JSON 表格：能被解析成对象就渲染成「字段名 → 值」的表，否则回退成 Markdown 代码块。
//
// 原本是 BidAnalysisPage.tsx 里的一个模块级组件（28 行）。

import { MarkdownFullscreenViewer, MarkdownRenderer } from '../../../shared/ui';
import { formatJsonValue, jsonFieldLabels, tryParseJsonObject } from '../bidAnalysisModel';

export function JsonResultTable({ content }: { content: string }) {
  const data = tryParseJsonObject(content);

  if (!data) {
    return (
      <MarkdownFullscreenViewer className="markdown-viewer bid-analysis-output" title="JSON 内容全屏预览">
        <MarkdownRenderer>
          {`\`\`\`json\n${content}\n\`\`\``}
        </MarkdownRenderer>
      </MarkdownFullscreenViewer>
    );
  }

  return (
    <div className="bid-analysis-json-table-wrap">
      <table className="bid-analysis-json-table">
        <tbody>
          {Object.entries(data).map(([key, value]) => (
            <tr key={key}>
              <th>{jsonFieldLabels[key] || key}</th>
              <td>{formatJsonValue(value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
