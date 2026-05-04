"""
clusterer.py — hierarchical codebase clustering via HAC + Gemini labeling.

Composite pattern — every node is a Quanta:
  - Internal node: label, summary, children (sub-Quanta), edges (between children)
  - Leaf node:     label, file_path, summary, nodes (responsibility groups), edges

Pipeline:
  1. Collapse chunks → file-level nodes (average summary_vectors per file)
  2. HAC on summary_vectors (cosine distance) → dendrogram
  3. Cut dendrogram dynamically to get natural clusters
  4. Recurse until cluster is small enough to be a leaf
  5. Gemini labels each internal node + extracts leaf responsibility graph

Dependencies:
    pip install scikit-learn numpy google-genai
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import re

import numpy as np
from dotenv import load_dotenv
from google import genai
from google.genai import types
from sklearn.cluster import AgglomerativeClustering
from sklearn.preprocessing import normalize

from backend.db.database import (
    insert_domain,
    update_vector_domain,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

load_dotenv()

GOOGLE_CLOUD_PROJECT  = os.getenv("GOOGLE_CLOUD_PROJECT")
GOOGLE_CLOUD_LOCATION = os.getenv("GOOGLE_CLOUD_LOCATION", "us-central1")

_gemini = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

GEMINI_MODEL = "gemini-2.5-flash-lite"
GEMINI_TIMEOUT_SECONDS = 45
FAST_CLUSTER_LABELS = os.getenv("FAST_CLUSTER_LABELS", "false").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
CLUSTER_TREE_SCHEMA_VERSION = 2
MAX_CHILDREN_PER_CLUSTER = 15


# ---------------------------------------------------------------------------
# Threshold inference
# ---------------------------------------------------------------------------

def _infer_thresholds(files: list[dict]) -> tuple[float, int]:
    """Infer clustering thresholds from file composition."""
    extensions = [f["file_path"].split(".")[-1] for f in files]
    tsx_ratio = extensions.count("tsx") / max(len(extensions), 1)

    if tsx_ratio > 0.5:
        return 0.25, 5   # frontend-heavy
    elif len(files) > 60:
        return 0.35, 3   # large mixed repo
    else:
        return 0.4, 3    # default

LANGUAGE_FAMILIES = {
    # Config / build tooling — should cluster together
    'json': 'config',
    'toml': 'config',
    'yaml': 'config',
    'yml': 'config',
    'lock': 'config',
    # Docs
    'md': 'docs',
    'txt': 'docs',
    'rst': 'docs',
    # Python application logic
    'py': 'python',
    # TypeScript / JavaScript (auth, proxy, next config etc.)
    'ts': 'typescript',
    'js': 'javascript',
    'tsx': 'typescript',
    'jsx': 'javascript',
}


def _split_root_group(files: list[dict]) -> dict[str, list[dict]]:
    """
    Split root-level files by language family so HAC doesn't mix
    application logic (Backend.py) with build config (package.json).
    Returns a dict of sub-group-key → file list.
    Groups with only one file stay as singletons — they will become
    leaf children of root, which is correct.
    """
    sub_groups: dict[str, list[dict]] = {}
    for f in files:
        ext = f['file_path'].rsplit('.', 1)[-1].lower() if '.' in f['file_path'] else 'unknown'
        family = LANGUAGE_FAMILIES.get(ext, f'other_{ext}')
        sub_groups.setdefault(family, []).append(f)
    return sub_groups


def _group_by_path(files: list[dict]) -> list[list[dict]]:
    """Group files by top-level directory. Root-level files share one group."""
    groups: dict[str, list[dict]] = {}
    for f in files:
        parts = f["file_path"].replace("\\", "/").split("/")
        if len(parts) == 1:
            key = "__root__"
        elif len(parts) == 2:
            key = parts[0]
        else:
            key = f"{parts[0]}/{parts[1]}"
        groups.setdefault(key, []).append(f)

    # Split the root-level bucket by language family so application logic
    # files (Backend.py) don't cluster with build config files (package.json).
    result: list[list[dict]] = []
    for key, file_list in groups.items():
        if key == "__root__":
            for sub_list in _split_root_group(file_list).values():
                result.append(sub_list)
        else:
            result.append(file_list)

    # Merge singleton groups into related groups when they share a semantic
    # relationship identifiable by path prefix. Specifically: any group with
    # exactly one file whose path starts with "types/" should merge into the
    # typescript root sub-group if one exists, since type declaration files
    # belong with their corresponding runtime files.
    def _is_root_typescript_group(g: list[dict]) -> bool:
        if len(g) <= 1:
            return False
        all_root = all('/' not in f['file_path'].replace('\\', '/') for f in g)
        any_ts = any(f['file_path'].endswith(('.ts', '.tsx')) for f in g)
        return all_root and any_ts

    typescript_group_idx = next(
        (i for i, g in enumerate(result) if _is_root_typescript_group(g)),
        None,
    )
    # Note: only merge if the typescript group exists and has multiple files —
    # don't merge into another singleton.
    types_singletons = [
        f
        for g in result
        for f in g
        if len(g) == 1 and f['file_path'].replace('\\', '/').startswith('types/')
    ]
    if typescript_group_idx is not None and types_singletons:
        result[typescript_group_idx].extend(types_singletons)
        result = [
            g for g in result
            if not (len(g) == 1 and g[0]['file_path'].replace('\\', '/').startswith('types/'))
        ]
    return result


def _file_sort_key(file: dict) -> str:
    return file["file_path"].replace("\\", "/").lower()


def _group_sort_key(group: list[dict]) -> str:
    if not group:
        return ""
    return min(_file_sort_key(f) for f in group)


def _group_centroid(group: list[dict]) -> list[float] | None:
    vectors = [f["summary_vector"] for f in group if f.get("summary_vector") is not None]
    if not vectors:
        return None
    arr = np.array(vectors, dtype=np.float32)
    return arr.mean(axis=0).tolist()


def _limit_group_count(
        groups: list[list[dict]],
        max_children: int = MAX_CHILDREN_PER_CLUSTER,
) -> list[list[dict]]:
    """
    Merge generated groups so a cluster never has more than max_children direct children.
    Uses semantic centroids when available, with a deterministic path fallback.
    """
    groups = [sorted(group, key=_file_sort_key) for group in groups if group]
    if len(groups) <= max_children:
        return sorted(groups, key=_group_sort_key)

    centroids = [_group_centroid(group) for group in groups]
    if all(centroid is not None for centroid in centroids):
        vectors = normalize(np.array(centroids, dtype=np.float32))
        model = AgglomerativeClustering(
            n_clusters=max_children,
            metric="euclidean",
            linkage="average",
        )
        labels = model.fit_predict(vectors)

        merged: dict[int, list[dict]] = {}
        for group, label in zip(groups, labels):
            merged.setdefault(int(label), []).extend(group)

        limited = [sorted(group, key=_file_sort_key) for group in merged.values()]
        return sorted(limited, key=_group_sort_key)

    sorted_groups = sorted(groups, key=_group_sort_key)
    chunk_size = max(1, math.ceil(len(sorted_groups) / max_children))
    limited = [
        sorted(
            [file for group in sorted_groups[i:i + chunk_size] for file in group],
            key=_file_sort_key,
        )
        for i in range(0, len(sorted_groups), chunk_size)
    ]
    return sorted(limited, key=_group_sort_key)


def _validate_tree_limits(
        node: dict,
        max_children: int = MAX_CHILDREN_PER_CLUSTER,
        path: str = "root",
) -> list[str]:
    """Return validation errors for composite-tree display invariants."""
    errors: list[str] = []
    if node.get("type") == "cluster":
        children = node.get("children", [])
        if len(children) > max_children:
            errors.append(
                f"{path} ({node.get('label', 'unlabeled')}) has {len(children)} children; max is {max_children}"
            )
        for index, child in enumerate(children):
            label = child.get("label") or f"child-{index}"
            errors.extend(_validate_tree_limits(child, max_children, f"{path}/{label}"))
    return errors


def _dedupe_sibling_labels(children: list[dict]) -> None:
    """
    Ensure direct siblings have unique labels before parent edges are generated.
    Label collisions are valid natural-language output from Gemini, but the graph
    UI and parent edge prompts need direct-child labels to be distinguishable.
    """
    seen: dict[str, int] = {}
    for child in children:
        base_label = str(child.get("label") or child.get("file_path") or child.get("type") or "Untitled").strip()
        if not base_label:
            base_label = "Untitled"
        seen[base_label] = seen.get(base_label, 0) + 1
        child["label"] = base_label if seen[base_label] == 1 else f"{base_label} {seen[base_label]}"
# ---------------------------------------------------------------------------
# Clustering defaults (used only as fallback defaults in signatures)
# ---------------------------------------------------------------------------

_DEFAULT_DISTANCE_THRESHOLD = 0.4
_DEFAULT_MAX_LEAF_FILES     = 3
_DEFAULT_MAX_GROUP_SIZE     = 10
MIN_CLUSTER_SIZE            = 2
MAX_CLUSTER_SIZE            = 20

_SEMAPHORE = asyncio.Semaphore(10)


# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------

_CLUSTER_LABEL_PROMPT = """
You are labeling a cluster of related source files for a codebase exploration tool.

Here are the summaries of the files in this cluster:
{summaries}

Return ONLY valid JSON with no preamble or markdown. Schema:
{{
  "label": "short name for this cluster (2-4 words, title case)",
  "summary": "one sentence describing what this cluster of files collectively does",
  "edges": [
    {{"from": "child_label_1", "to": "child_label_2", "label": "interaction description"}}
  ]
}}

The edges should describe meaningful interactions BETWEEN the direct children listed.
Only include edges where there is a clear dependency or data flow between children.
Child labels are: {child_labels}
"""

_LEAF_PROMPT = """
You are analyzing a single source file for a codebase exploration tool.

File: {file_path}
Language: {language}
Summary: {summary}

Extract the internal logical components of this file and how they interact.
Do NOT reference external files or systems — only what exists within this file.

The "label" field must be the file's architectural role in the codebase
(e.g. "Flashcard Generator", "Authentication Logic", "Card State Manager").
Do NOT name the label after an internal function or component inside the file.
The label is used as a navigation target in a graph UI — it must be meaningful
to someone looking at the codebase from the outside.

Return ONLY valid JSON with no preamble or markdown. Schema:
{{
  "label": "short component name (2-4 words, title case)",
  "summary": "one sentence describing what this file does",
  "nodes": [
    {{"id": "snake_case_id", "label": "Component Name", "responsibility": "one line"}}
  ],
  "edges": [
    {{"from": "node_id_1", "to": "node_id_2", "label": "what flows or is called"}}
  ]
}}

Keep nodes between 2-5. Only add edges where there is a clear internal interaction.
"""


# ---------------------------------------------------------------------------
# Gemini helpers
# ---------------------------------------------------------------------------

async def _call_gemini(prompt: str) -> dict:
    """Call Gemini and parse JSON response. Returns empty dict on failure."""
    async with _SEMAPHORE:
        for attempt in range(3):
            try:
                response = await asyncio.wait_for(
                    _gemini.aio.models.generate_content(
                        model=GEMINI_MODEL,
                        contents=prompt,
                        config=types.GenerateContentConfig(
                            temperature=0.2,
                        ),
                    ),
                    timeout=GEMINI_TIMEOUT_SECONDS,
                )
                text = (response.text or "").strip()
                text = re.sub(r"^```json\s*", "", text)
                text = re.sub(r"\s*```$", "", text)
                return json.loads(text)
            except asyncio.TimeoutError:
                logger.warning("Gemini call timed out attempt %d", attempt + 1)
                if attempt == 2:
                    return {}
            except json.JSONDecodeError as e:
                logger.warning("JSON parse failed attempt %d: %s", attempt + 1, e)
                if attempt == 2:
                    return {}
            except Exception as e:
                logger.warning("Gemini call failed attempt %d: %s", attempt + 1, e)
                if attempt == 2:
                    return {}
                await asyncio.sleep(2 ** attempt)
    return {}


# ---------------------------------------------------------------------------
# Step 1 — Collapse chunks to file-level nodes
# ---------------------------------------------------------------------------

def collapse_to_files(enriched_chunks: list[dict]) -> list[dict]:
    """
    Collapse chunk-level dicts into file-level nodes.
    Averages summary_vectors for split files.
    """
    file_map: dict[str, dict] = {}

    for chunk in enriched_chunks:
        fp = chunk["file_path"]
        if fp not in file_map:
            file_map[fp] = {
                "file_path": fp,
                "language": chunk.get("language"),
                "file_type": chunk.get("file_type"),
                "summary": chunk.get("summary", ""),
                "vectors": [],
                "chunk_ids": [],
            }
        if chunk.get("summary_vector") is not None:
            file_map[fp]["vectors"].append(chunk["summary_vector"])
        if len(chunk.get("summary", "")) > len(file_map[fp]["summary"]):
            file_map[fp]["summary"] = chunk.get("summary", "")

    files = []
    for fp, node in file_map.items():
        vecs = node.pop("vectors")
        if vecs:
            arr = np.array(vecs, dtype=np.float32)
            node["summary_vector"] = arr.mean(axis=0).tolist()
        else:
            node["summary_vector"] = None
        files.append(node)

    return files


# ---------------------------------------------------------------------------
# Step 2 — HAC clustering
# ---------------------------------------------------------------------------

def _cluster_files(
        files: list[dict],
        distance_threshold: float = _DEFAULT_DISTANCE_THRESHOLD,
        max_group_size: int = 10,
) -> list[list[dict]]:
    valid   = [f for f in files if f["summary_vector"] is not None]
    invalid = [f for f in files if f["summary_vector"] is None]

    if len(valid) <= MIN_CLUSTER_SIZE:
        groups = [[f] for f in valid]
        if invalid:
            groups.append(invalid)
        return groups

    vectors = np.array([f["summary_vector"] for f in valid], dtype=np.float32)
    vectors = normalize(vectors)

    model = AgglomerativeClustering(
        n_clusters=None,
        distance_threshold=distance_threshold,
        metric="euclidean",
        linkage="average",
    )
    labels = model.fit_predict(vectors)

    groups: dict[int, list[dict]] = {}
    for file, label in zip(valid, labels):
        groups.setdefault(label, []).append(file)

    result = list(groups.values())

    # Force-split any group that exceeds max_group_size
    final = []
    for group in result:
        if len(group) <= max_group_size:
            final.append(group)
        else:
            #Fallback: split by directory instead of arbitrary chunks
            dir_groups: dict[str, list[dict]] = {}
            for f in group:
                parts = f["file_path"].replace("\\", "/").split("/")
                key = parts[0] if len(parts) > 1 else "__root__"
                dir_groups.setdefault(key, []).append(f)

            for dir_group in dir_groups.values():
                if len(dir_group) <= max_group_size:
                    final.append(dir_group)
                else:
                    # Directory group still too large — chunk it
                    for i in range(0, len(dir_group), max_group_size):
                        final.append(dir_group[i:i + max_group_size])

    if invalid:
        final.extend([[f] for f in invalid])
    return final


def _fallback_leaf_label(file: dict) -> str:
    return file["file_path"].replace("\\", "/").split("/")[-1]


def _fallback_cluster_label(files: list[dict], depth: int) -> str:
    normalized_paths = [f["file_path"].replace("\\", "/") for f in files]
    prefix_parts = [path.split("/")[:2] for path in normalized_paths if "/" in path]
    if prefix_parts:
        candidate = prefix_parts[0]
        if all(parts[:len(candidate)] == candidate for parts in prefix_parts):
            return " / ".join(candidate)
    return f"Cluster {depth + 1}"


def _fallback_cluster_summary(files: list[dict]) -> str:
    return f"Contains {len(files)} related files."
# ---------------------------------------------------------------------------
# Step 3 — Recursive tree builder
# ---------------------------------------------------------------------------

async def _build_leaf(file: dict) -> dict:
    """Build a leaf Quanta node for a single file."""
    if FAST_CLUSTER_LABELS:
        label = _fallback_leaf_label(file)
        summary = file.get("summary") or "Summary unavailable."
        return {
            "type": "leaf",
            "label": label,
            "summary": summary,
            "file_path": file["file_path"],
            "language": file.get("language"),
            "file_type": file.get("file_type"),
            "nodes": [
                {
                    "id": "file_overview",
                    "label": "File Overview",
                    "responsibility": summary,
                }
            ],
            "edges": [],
            "children": [],
        }

    prompt = _LEAF_PROMPT.format(
        file_path=file["file_path"],
        language=file.get("language") or "unknown",
        summary=file.get("summary") or "No summary available.",
    )
    gemini_data = await _call_gemini(prompt)

    return {
        "type": "leaf",
        "label": gemini_data.get("label") or _fallback_leaf_label(file),
        "summary": gemini_data.get("summary") or file.get("summary") or "Summary unavailable.",
        "file_path": file["file_path"],
        "language": file.get("language"),
        "file_type": file.get("file_type"),
        "nodes": gemini_data.get("nodes", []),
        "edges": gemini_data.get("edges", []),
        "children": [],
    }


async def _build_cluster(
        files: list[dict],
        depth: int = 0,
        distance_threshold: float = _DEFAULT_DISTANCE_THRESHOLD,
        max_leaf_files: int = _DEFAULT_MAX_LEAF_FILES,
        max_group_size: int = _DEFAULT_MAX_GROUP_SIZE,
) -> dict:
    """
    Recursively build an internal Quanta node.
    Splits into subclusters if too large, collapses to leaf if small enough.
    """
    if len(files) == 1:
        return await _build_leaf(files[0])

    if len(files) <= max_leaf_files:
        children = list(await asyncio.gather(*[_build_leaf(f) for f in files]))
    else:
        groups = _cluster_files(files, distance_threshold, max_group_size)

        if len(groups) == 1 and len(files) > max_leaf_files:
            path_groups = [group for group in _group_by_path(files) if group]
            if 1 < len(path_groups) <= len(files):
                groups = path_groups
            else:
                groups = [
                    files[i:i + max_group_size]
                    for i in range(0, len(files), max_group_size)
                ]

        groups = _limit_group_count(groups)

        children = list(await asyncio.gather(*[
            _build_cluster(group, depth + 1, distance_threshold, max_leaf_files, max_group_size)
            for group in groups
        ]))

    if len(children) > MAX_CHILDREN_PER_CLUSTER:
        raise ValueError(
            f"cluster build produced {len(children)} direct children at depth {depth}; "
            f"max is {MAX_CHILDREN_PER_CLUSTER}"
        )

    _dedupe_sibling_labels(children)

    child_labels    = [c["label"] for c in children]
    child_summaries = "\n".join(
        f"- {c['label']}: {c.get('summary', '')}" for c in children
    )

    if FAST_CLUSTER_LABELS:
        gemini_data = {}
    else:
        prompt = _CLUSTER_LABEL_PROMPT.format(
            summaries=child_summaries,
            child_labels=", ".join(child_labels),
        )
        gemini_data = await _call_gemini(prompt)

    return {
        "type": "cluster",
        "label": gemini_data.get("label") or _fallback_cluster_label(files, depth),
        "summary": gemini_data.get("summary") or _fallback_cluster_summary(files),
        "edges": gemini_data.get("edges", []),
        "children": children,
    }


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

async def build_cluster_tree(
        enriched_chunks: list[dict],
        repo_id: str,
) -> dict:
    """
    Full clustering pipeline.

    1. Collapse chunks to file-level nodes
    2. Infer thresholds from repo composition
    3. Recursively cluster into Quanta tree
    4. Return root node as JSON-serializable dict
    """
    logger.info("collapsing %d chunks to file nodes", len(enriched_chunks))
    files = collapse_to_files(enriched_chunks)

    distance_threshold, max_leaf_files = _infer_thresholds(files)
    logger.info("thresholds — distance: %s  max_leaf: %s", distance_threshold, max_leaf_files)
    logger.info("clustering %d files", len(files))

    tsx_ratio = sum(1 for f in files if f["file_path"].endswith(".tsx")) / max(len(files), 1)

    if tsx_ratio > 0.5:
        groups = _group_by_path(files)
        logger.info("path-based grouping: %d top-level groups", len(groups))
    else:
        groups = _cluster_files(files, distance_threshold, max_group_size=_DEFAULT_MAX_GROUP_SIZE)
        logger.info("HAC grouping: %d top-level groups", len(groups))

    groups = _limit_group_count(groups)
    logger.info("top-level groups after child-limit pass: %d", len(groups))

    if len(groups) == 1:
        root = await _build_cluster(
            files,
            distance_threshold=distance_threshold,
            max_leaf_files=max_leaf_files,
            max_group_size=_DEFAULT_MAX_GROUP_SIZE,
        )
    else:
        children = list(await asyncio.gather(*[
            _build_cluster(
                group,
                distance_threshold=distance_threshold,
                max_leaf_files=max_leaf_files,
                max_group_size=_DEFAULT_MAX_GROUP_SIZE,
            )
            for group in groups
        ]))

        _dedupe_sibling_labels(children)

        child_labels    = [c["label"] for c in children]
        child_summaries = "\n".join(
            f"- {c['label']}: {c.get('summary', '')}" for c in children
        )
        if FAST_CLUSTER_LABELS:
            gemini_data = {}
        else:
            prompt = _CLUSTER_LABEL_PROMPT.format(
                summaries=child_summaries,
                child_labels=", ".join(child_labels),
            )
            gemini_data = await _call_gemini(prompt)

        root = {
            "type": "cluster",
            "label": gemini_data.get("label") or _fallback_cluster_label(files, 0),
            "summary": gemini_data.get("summary") or _fallback_cluster_summary(files),
            "edges": gemini_data.get("edges", []),
            "children": children,
        }

    root["schema_version"] = CLUSTER_TREE_SCHEMA_VERSION
    root["max_children_per_cluster"] = MAX_CHILDREN_PER_CLUSTER

    limit_errors = _validate_tree_limits(root)
    if limit_errors:
        raise ValueError("cluster tree child limit validation failed: " + "; ".join(limit_errors[:5]))

    logger.info("cluster tree built — root label: %s", root.get("label"))
    return root


def flatten_tree(node: dict, repo_id: str, parent_id: str | None = None) -> list[dict]:
    """
    Flatten the tree into a list of domain rows for DB insertion.
    """
    rows = []
    rows.append({
        "repo_id": repo_id,
        "parent_id": parent_id,
        "label": node["label"],
        "summary": node.get("summary", ""),
        "node_type": node["type"],
        "file_path": node.get("file_path"),
        "language": node.get("language"),
        "nodes": node.get("nodes", []),
        "edges": node.get("edges", []),
        "children_labels": [c["label"] for c in node.get("children", [])],
    })
    for child in node.get("children", []):
        rows.extend(flatten_tree(child, repo_id, parent_id="__placeholder__"))
    return rows
