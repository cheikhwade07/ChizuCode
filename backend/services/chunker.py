"""
chunker.py — AST-aware file chunker for codebase exploration.

No external dependencies — uses Python's built-in ast module for Python files
and regex-based detection for other languages.

Strategy:
  - needs_splitting=False  → single chunk
  - file_type != "code"    → single chunk always (config/doc)
  - language == python     → split via built-in ast module (precise)
  - other known languages  → split via regex function/class detection
  - any failure            → single chunk (never cut functions in half)
"""

from __future__ import annotations

import ast
import re

MIN_NODE_LINES = 5

_TOPLEVEL_REGEX: dict[str, re.Pattern] = {
    "javascript": re.compile(
        r"^(export\s+)?(default\s+)?(async\s+)?function[\s*]\w+"
        r"|^(export\s+)?(default\s+)?class\s+\w+"
        r"|^(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s*)?(function|\(|async)"
    ),
    "typescript": re.compile(
        r"^(export\s+)?(default\s+)?(async\s+)?function[\s*]\w+"
        r"|^(export\s+)?(default\s+)?(abstract\s+)?class\s+\w+"
        r"|^(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s*)?(function|\(|async)"
        r"|^(export\s+)?(interface|type|enum)\s+\w+"
    ),
    "java": re.compile(
        r"^\s*(public|private|protected|static|final|abstract|synchronized)"
        r"(\s+(public|private|protected|static|final|abstract|synchronized))*"
        r"\s+\w[\w<>\[\]]*\s+\w+\s*\("
        r"|^\s*(public|private|protected)?\s*(class|interface|enum|record)\s+\w+"
    ),
    "go": re.compile(
        r"^func\s+(\(\s*\w+\s+\*?\w+\s*\)\s*)?\w+\s*\("
        r"|^type\s+\w+\s+(struct|interface)\s*\{"
    ),
    "rust": re.compile(
        r"^(pub(\(crate\))?\s+)?(async\s+)?fn\s+\w+"
        r"|^(pub(\(crate\))?\s+)?(struct|enum|trait|impl|mod)\s+\w+"
    ),
    "ruby": re.compile(
        r"^\s*def\s+\w+"
        r"|^\s*class\s+\w+"
        r"|^\s*module\s+\w+"
    ),
    "c_sharp": re.compile(
        r"^\s*(public|private|protected|internal|static|override|virtual|abstract)"
        r"(\s+(public|private|protected|internal|static|override|virtual|abstract))*"
        r"\s+\w[\w<>\[\]]*\s+\w+\s*[\(\{]"
        r"|^\s*(public|private|protected|internal)?\s*(class|interface|enum|struct|record)\s+\w+"
    ),
    "kotlin": re.compile(r"^\s*(fun|class|object|interface|data class|sealed class)\s+\w+"),
    "swift": re.compile(r"^\s*(func|class|struct|enum|protocol|extension)\s+\w+"),
    "php": re.compile(r"^\s*(function\s+\w+|class\s+\w+|interface\s+\w+|trait\s+\w+)"),
    "scala": re.compile(r"^\s*(def|class|object|trait|case class)\s+\w+"),
}
_TOPLEVEL_REGEX["tsx"] = _TOPLEVEL_REGEX["typescript"]


def _build_chunk(*, file_path, lines, start_line, end_line, language, file_type, is_split, chunk_index):
    content = "".join(lines[start_line - 1:end_line])
    return {
        "file_path": file_path, "content": content,
        "start_line": start_line, "end_line": end_line,
        "loc": end_line - start_line + 1, "language": language,
        "file_type": file_type, "is_split": is_split, "chunk_index": chunk_index,
    }


def _single_chunk(file):
    lines = file["content"].splitlines(keepends=True)
    total = len(lines) or 1
    return [_build_chunk(file_path=file["file_path"], lines=lines, start_line=1,
                         end_line=total, language=file.get("language"), file_type=file["file_type"],
                         is_split=False, chunk_index=0)]


def _merge_short_spans(spans, min_lines):
    if len(spans) <= 1:
        return spans
    changed = True
    while changed:
        changed = False
        merged = []
        i = 0
        while i < len(spans):
            s, e = spans[i]
            if (e - s + 1) < min_lines:
                if i + 1 < len(spans):
                    spans[i + 1] = (s, spans[i + 1][1])
                    changed = True
                    i += 1
                    continue
                elif merged:
                    merged[-1] = (merged[-1][0], e)
                    changed = True
                    i += 1
                    continue
            merged.append((s, e))
            i += 1
        spans = merged
    return spans


def _spans_to_chunks(file, spans):
    lines = file["content"].splitlines(keepends=True)
    total = len(lines) or 1
    spans = _merge_short_spans(spans, MIN_NODE_LINES)
    is_split = not (len(spans) == 1 and spans[0] == (1, total))
    chunks = []
    for idx, (start, end) in enumerate(spans):
        start = max(1, min(start, total))
        end = max(start, min(end, total))
        chunks.append(_build_chunk(file_path=file["file_path"], lines=lines,
                                   start_line=start, end_line=end, language=file.get("language"),
                                   file_type=file["file_type"], is_split=is_split, chunk_index=idx))
    return chunks


def _python_spans(content):
    try:
        tree = ast.parse(content)
    except SyntaxError:
        return None
    spans = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            spans.append((node.lineno, node.end_lineno))
    return spans if spans else None


def _regex_spans(content, pattern):
    lines = content.splitlines()
    total = len(lines)
    if not total:
        return None
    start_lines = [i + 1 for i, line in enumerate(lines) if pattern.match(line)]
    if not start_lines:
        return None
    spans = []
    for i, start in enumerate(start_lines):
        end = start_lines[i + 1] - 1 if i + 1 < len(start_lines) else total
        spans.append((start, end))
    return spans


def chunk_files(files):
    result = []
    for file in files:
        file_type = file.get("file_type", "code")
        needs_splitting = file.get("needs_splitting", False)
        language = file.get("language")

        if not needs_splitting or file_type != "code":
            result.extend(_single_chunk(file))
            continue

        spans = None
        if language == "python":
            spans = _python_spans(file["content"])
        elif language in _TOPLEVEL_REGEX:
            spans = _regex_spans(file["content"], _TOPLEVEL_REGEX[language])

        if spans:
            result.extend(_spans_to_chunks(file, spans))
        else:
            result.extend(_single_chunk(file))

    return result