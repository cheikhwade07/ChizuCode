import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Generator


# --- supported file types ---------------------------------------------------

CODE_EXTENSIONS = {
    # Python
    ".py", ".pyi",
    # JavaScript / TypeScript
    ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
    # Java / Kotlin
    ".java", ".kt", ".kts",
    # Go
    ".go",
    # Rust
    ".rs",
    # C / C++
    ".c", ".cpp", ".cc", ".h", ".hpp",
    # Ruby
    ".rb",
    # PHP
    ".php",
    # Swift
    ".swift",
    # C#
    ".cs",
    # Scala
    ".scala",
    # Shell
    ".sh", ".bash", ".zsh",
}

CONFIG_EXTENSIONS = {
    ".json", ".yaml", ".yml", ".toml", ".ini",
    ".env.example", ".cfg", ".conf",
}

DOC_EXTENSIONS = {
    ".md", ".mdx", ".rst", ".txt",
}

SUPPORTED_EXTENSIONS = CODE_EXTENSIONS | CONFIG_EXTENSIONS | DOC_EXTENSIONS

# files to always skip regardless of extension
IGNORED_FILENAMES = {
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    "poetry.lock", "Cargo.lock", "Gemfile.lock",
    "pipfile.lock", ".DS_Store", "thumbs.db",
}

# directories to always skip
IGNORED_DIRS = {
    "__pycache__", "node_modules", ".venv", "venv", "env",
    ".git", "dist", "build", ".next", "out", "coverage",
    ".pytest_cache", ".mypy_cache", "target", "vendor",
    ".idea", ".vscode",
}

MAX_FILE_SIZE_BYTES = 500_000   # skip files over 500KB
LOC_SPLIT_THRESHOLD = 500       # files over this flagged for chunker splitting


# --- language detection ------------------------------------------------------

# maps extension → tree-sitter language name
TREE_SITTER_LANGUAGE_MAP = {
    ".py":    "python",
    ".pyi":   "python",
    ".js":    "javascript",
    ".jsx":   "javascript",
    ".mjs":   "javascript",
    ".cjs":   "javascript",
    ".ts":    "typescript",
    ".tsx":   "tsx",
    ".java":  "java",
    ".kt":    "kotlin",
    ".go":    "go",
    ".rs":    "rust",
    ".c":     "c",
    ".h":     "c",
    ".cpp":   "cpp",
    ".cc":    "cpp",
    ".hpp":   "cpp",
    ".rb":    "ruby",
    ".cs":    "c_sharp",
    ".scala": "scala",
    ".swift": "swift",
    ".php":   "php",
}


def get_language(file_path: str) -> str | None:
    """
    Return the tree-sitter language name for a file, or None if
    the file type does not need AST-level splitting (config, docs).
    """
    ext = Path(file_path).suffix.lower()
    return TREE_SITTER_LANGUAGE_MAP.get(ext)


# --- errors ------------------------------------------------------------------

class RepoIngestionError(Exception):
    pass


# --- core functions ----------------------------------------------------------

def parse_github_url(url: str) -> tuple[str, str]:
    """
    Extract owner and repo name from a GitHub URL.
    https://github.com/owner/repo  →  ("owner", "repo")
    """
    parts = url.rstrip("/").removesuffix(".git").split("/")
    if len(parts) < 2:
        raise RepoIngestionError(f"Invalid GitHub URL: {url}")
    return parts[-2], parts[-1]


def clone_repo(github_url: str) -> str:
    """
    Shallow-clone a public GitHub repo into a temp directory.
    Returns the path to the cloned repo root.
    Caller must call cleanup_repo() when done — even on failure.
    """
    tmp_dir = tempfile.mkdtemp(prefix="codex_")

    try:
        result = subprocess.run(
            [
                "git", "clone",
                "--depth", "1",       # no history — faster, smaller
                "--single-branch",    # default branch only
                github_url,
                tmp_dir,
            ],
            capture_output=True,
            text=True,
            timeout=60,
        )
    except subprocess.TimeoutExpired:
        cleanup_repo(tmp_dir)
        raise RepoIngestionError(f"Clone timed out for {github_url}")

    if result.returncode != 0:
        cleanup_repo(tmp_dir)
        raise RepoIngestionError(f"Git clone failed: {result.stderr.strip()}")

    return tmp_dir


def walk_files(repo_path: str) -> Generator[dict, None, None]:
    """
    Walk the cloned repo and yield one dict per supported file.

    Yields:
        {
            file_path:       str        relative path from repo root
            content:         str        full file text
            loc:             int        line count
            size_bytes:      int
            language:        str|None   tree-sitter language, None for docs/config
            needs_splitting: bool       True if loc > threshold and language is known
            file_type:       str        "code" | "config" | "doc"
        }
    """
    repo_root = Path(repo_path)

    for file_path in sorted(repo_root.rglob("*")):

        if not file_path.is_file():
            continue

        relative = file_path.relative_to(repo_root)

        # skip ignored directories anywhere in the path
        if any(part in IGNORED_DIRS or part.startswith(".")
               for part in relative.parts[:-1]):
            continue

        # skip ignored filenames (lockfiles, OS files, etc.)
        if file_path.name in IGNORED_FILENAMES:
            continue

        # skip unsupported extensions
        suffix = file_path.suffix.lower()
        if suffix not in SUPPORTED_EXTENSIONS:
            continue

        # skip oversized files (generated, minified, data dumps)
        size = file_path.stat().st_size
        if size > MAX_FILE_SIZE_BYTES:
            continue

        # skip binary files by sniffing first 1024 bytes
        try:
            raw = file_path.read_bytes()
            if b"\x00" in raw[:1024]:
                continue
            content = raw.decode("utf-8", errors="ignore")
        except Exception:
            continue

        # skip empty or whitespace-only files
        if not content.strip():
            continue

        loc = content.count("\n") + 1
        language = get_language(str(relative))

        if suffix in CODE_EXTENSIONS:
            file_type = "code"
        elif suffix in CONFIG_EXTENSIONS:
            file_type = "config"
        else:
            file_type = "doc"

        # only flag for AST splitting if we have a known language parser
        needs_splitting = (loc > LOC_SPLIT_THRESHOLD) and (language is not None)

        yield {
            "file_path": str(relative),
            "content": content,
            "loc": loc,
            "size_bytes": size,
            "language": language,
            "needs_splitting": needs_splitting,
            "file_type": file_type,
        }


def cleanup_repo(repo_path: str) -> None:
    """
    Delete the cloned temp directory.
    Always call this in a finally block — even if ingestion fails.
    """
    try:
        shutil.rmtree(repo_path)
    except Exception:
        pass  # best effort