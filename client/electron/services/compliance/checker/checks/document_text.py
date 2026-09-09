"""真实标书文本归一化：清掉文档转 Markdown 时留下的内部痕迹，四个检查项共用。"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

# U+0001 是转换器用来占位“单元格内换行”的哨兵；保留制表符/换行/回车，其余控制字符压成空格。
CONTROL_CHARS = re.compile(r"[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]")
# 转 Markdown 后每页会留下“##### 第 N 页”，跨页表格会被它从中间切断。
PAGE_MARKER = re.compile(r"^\s{0,3}#{0,6}\s*第\s*\d+\s*页(?:\s*/\s*共\s*\d+\s*页)?\s*$")
INLINE_MARKUP = re.compile(r"(\*\*|__|~~|`+)")


def normalize_document_text(text: str) -> str:
    cleaned = CONTROL_CHARS.sub(" ", text or "")
    return "\n".join(line for line in cleaned.splitlines() if not PAGE_MARKER.match(line))


def clean_cell(value: Any) -> str:
    return re.sub(r"\s+", " ", INLINE_MARKUP.sub("", str(value or ""))).strip()


def read_document_text(path: Any) -> str:
    value = str(path or "").strip()
    if not value:
        return ""
    try:
        raw = Path(value).read_bytes()
    except OSError:
        return ""
    for encoding in ("utf-8-sig", "utf-8", "gb18030", "gbk"):
        try:
            return normalize_document_text(raw.decode(encoding))
        except UnicodeDecodeError:
            continue
    return normalize_document_text(raw.decode("utf-8", errors="replace"))

