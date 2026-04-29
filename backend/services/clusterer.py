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
import re
from typing import Any

import numpy as np
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

import os
from dotenv import load_dotenv
load_dotenv()

GOOGLE_CLOUD_PROJECT  = os.getenv("GOOGLE_CLOUD_PROJECT")
GOOGLE_CLOUD_LOCATION = os.getenv("GOOGLE_CLOUD_LOCATION", "us-central1")

_gemini = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

GEMINI_MODEL = "gemini-2.5-flash-lite"

# Clustering thresholds
MAX_LEAF_FILES      = 3    # clusters with <= this many files become leaves
MIN_CLUSTER_SIZE    = 2    # don't create clusters smaller than this
MAX_CLUSTER_SIZE    = 20   # clusters larger than this get recursively split
DISTANCE_THRESHOLD  = 0.4  # HAC cut threshold (cosine distance, 0=identical, 1=orthogonal)

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
                response = await _gemini.aio.models.generate_content(
                    model=GEMINI_MODEL,
                    contents=prompt,
                    config=types.GenerateContentConfig(
                        temperature=0.2,
                    ),
                )
                text = (response.text or "").strip()
                # strip markdown fences if present
                text = re.sub(r"^```json\s*", "", text)
                text = re.sub(r"\s*```$", "", text)
                return json.loads(text)
            except json.JSONDecodeError as e:
                logger.warning("JSON parse failed attempt %d: %s", attempt + 1, e)
                if attempt == 2:
                    return {}
            except Exception as e:
                wait = 2 ** attempt
                logger.warning("Gemini call failed attempt %d: %s", attempt + 1, e)
                if attempt == 2:
                    return {}
                await asyncio.sleep(wait)
    return {}


# ---------------------------------------------------------------------------
# Step 1 — Collapse chunks to file-level nodes
# ---------------------------------------------------------------------------

def collapse_to_files(enriched_chunks: list[dict]) -> list[dict]:
    """
    Collapse chunk-level dicts into file-level nodes.
    Averages summary_vectors for split files.

    Input:  enriched chunk dicts (output of process_chunks)
    Output: list of file-level dicts with averaged summary_vector
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
        # keep the best (longest) summary
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

def _cluster_files(files: list[dict]) -> list[list[dict]]:
    """
    Run HAC on summary_vectors and return groups of files.
    Files without vectors are put in their own singleton group.
    """
    valid   = [f for f in files if f["summary_vector"] is not None]
    invalid = [f for f in files if f["summary_vector"] is None]

    if len(valid) <= MIN_CLUSTER_SIZE:
        groups = [[f] for f in valid]
        if invalid:
            groups.append(invalid)
        return groups

    vectors = np.array([f["summary_vector"] for f in valid], dtype=np.float32)
    vectors = normalize(vectors)  # cosine via normalized euclidean

    model = AgglomerativeClustering(
        n_clusters=None,
        distance_threshold=DISTANCE_THRESHOLD,
        metric="euclidean",
        linkage="average",
    )
    labels = model.fit_predict(vectors)

    groups: dict[int, list[dict]] = {}
    for file, label in zip(valid, labels):
        groups.setdefault(label, []).append(file)

    result = list(groups.values())
    if invalid:
        result.extend([[f] for f in invalid])
    return result


# ---------------------------------------------------------------------------
# Step 3 — Recursive tree builder
# ---------------------------------------------------------------------------

async def _build_leaf(file: dict) -> dict:
    """Build a leaf Quanta node for a single file."""
    prompt = _LEAF_PROMPT.format(
        file_path=file["file_path"],
        language=file.get("language") or "unknown",
        summary=file.get("summary") or "No summary available.",
    )
    gemini_data = await _call_gemini(prompt)

    return {
        "type": "leaf",
        "label": gemini_data.get("label", file["file_path"].split("/")[-1]),
        "summary": gemini_data.get("summary", file.get("summary", "")),
        "file_path": file["file_path"],
        "language": file.get("language"),
        "file_type": file.get("file_type"),
        "nodes": gemini_data.get("nodes", []),
        "edges": gemini_data.get("edges", []),
        "children": [],
    }


async def _build_cluster(files: list[dict], depth: int = 0) -> dict:
    """
    Recursively build an internal Quanta node.
    Splits into subclusters if too large, collapses to leaf if small enough.
    """
    # Base case — single file
    if len(files) == 1:
        return await _build_leaf(files[0])

    # Base case — small enough to treat all as direct leaf children
    if len(files) <= MAX_LEAF_FILES:
        children = await asyncio.gather(*[_build_leaf(f) for f in files])
        children = list(children)
    else:
        # Recurse — split into subclusters
        groups = _cluster_files(files)

        # If clustering produced one group (all files too similar or too few),
        # force split to avoid infinite recursion
        if len(groups) == 1 and len(files) > MAX_LEAF_FILES:
            mid = len(files) // 2
            groups = [files[:mid], files[mid:]]

        child_tasks = [_build_cluster(group, depth + 1) for group in groups]
        children = list(await asyncio.gather(*child_tasks))

    # Label this cluster using its children's labels and summaries
    child_labels  = [c["label"] for c in children]
    child_summaries = "\n".join(
        f"- {c['label']}: {c.get('summary', '')}" for c in children
    )

    prompt = _CLUSTER_LABEL_PROMPT.format(
        summaries=child_summaries,
        child_labels=", ".join(child_labels),
    )
    gemini_data = await _call_gemini(prompt)

    return {
        "type": "cluster",
        "label": gemini_data.get("label", f"Cluster {depth}"),
        "summary": gemini_data.get("summary", ""),
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
    2. Recursively cluster into Quanta tree
    3. Return root node as JSON-serializable dict

    Does NOT persist to DB — call persist_cluster_tree separately.
    """
    logger.info("collapsing %d chunks to file nodes", len(enriched_chunks))
    files = collapse_to_files(enriched_chunks)
    logger.info("clustering %d files", len(files))

    # Top-level: cluster all files
    groups = _cluster_files(files)
    logger.info("top-level groups: %d", len(groups))

    if len(groups) == 1:
        # Single top-level cluster — build directly
        root = await _build_cluster(files)
    else:
        # Multiple top-level clusters — build each, wrap in synthetic root
        child_tasks = [_build_cluster(group) for group in groups]
        children = list(await asyncio.gather(*child_tasks))

        child_labels    = [c["label"] for c in children]
        child_summaries = "\n".join(
            f"- {c['label']}: {c.get('summary', '')}" for c in children
        )
        prompt = _CLUSTER_LABEL_PROMPT.format(
            summaries=child_summaries,
            child_labels=", ".join(child_labels),
        )
        gemini_data = await _call_gemini(prompt)

        root = {
            "type": "cluster",
            "label": gemini_data.get("label", "Codebase"),
            "summary": gemini_data.get("summary", ""),
            "edges": gemini_data.get("edges", []),
            "children": children,
        }

    logger.info("cluster tree built — root label: %s", root.get("label"))
    return root


def flatten_tree(node: dict, repo_id: str, parent_id: str | None = None) -> list[dict]:
    """
    Flatten the tree into a list of domain rows for DB insertion.
    Returns list of dicts ready for insert_domain().
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
