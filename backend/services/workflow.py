"""
workflow.py - deterministic workflow showcase builder.

This service builds animation payloads from the stored cluster tree, grounded
by the same RAG retrieval path used for normal questions. RAG chooses relevant
source files; this module maps those files back to exact graph labels so the
frontend animation has stable node IDs to target during demos.
"""

from __future__ import annotations

import re
from collections import deque
from typing import Any

from backend.services.rag import query_repo


def _tokens(text: str) -> set[str]:
    return {token for token in re.split(r"[^a-z0-9]+", text.lower()) if len(token) > 2}


def _score(text: str, query_tokens: set[str]) -> int:
    if not query_tokens:
        return 0
    haystack = _tokens(text)
    return len(haystack & query_tokens)


def _collect_leaves(node: dict[str, Any]) -> list[dict[str, Any]]:
    if node.get("type") == "leaf":
        return [node]
    leaves: list[dict[str, Any]] = []
    for child in node.get("children", []):
        leaves.extend(_collect_leaves(child))
    return leaves


def _collect_cluster_edges(node: dict[str, Any]) -> list[dict[str, str]]:
    if node.get("type") == "leaf":
        return []
    edges = list(node.get("edges", []))
    for child in node.get("children", []):
        edges.extend(_collect_cluster_edges(child))
    return edges


def _normalize_path(path: str | None) -> str:
    return (path or "").replace("\\", "/").strip().lower()


def _submaps_from_tree(tree: dict[str, Any]) -> list[dict[str, Any]]:
    if tree.get("type") == "leaf":
        return [{
            "name": tree.get("label", "Repository"),
            "id": tree.get("id"),
            "cluster": tree,
            "leaves": [tree],
            "edges": [],
        }]

    children = tree.get("children", [])
    cluster_children = [child for child in children if child.get("type") == "cluster"]
    leaf_children = [child for child in children if child.get("type") == "leaf"]

    if not cluster_children:
        return [{
            "name": tree.get("label", "Repository"),
            "id": tree.get("id"),
            "cluster": tree,
            "leaves": _collect_leaves(tree),
            "edges": _collect_cluster_edges(tree),
        }]

    submaps = [
        {
            "name": cluster.get("label", "Cluster"),
            "id": cluster.get("id"),
            "cluster": cluster,
            "leaves": _collect_leaves(cluster),
            "edges": _collect_cluster_edges(cluster),
        }
        for cluster in cluster_children
    ]

    # Each root-level orphan leaf gets its own submap so the workflow
    # animation can navigate to it precisely. Grouping them all into
    # "Project Root" means the animation lands in a cluttered bucket
    # of unrelated files.
    for leaf in leaf_children:
        submaps.append({
            "name": leaf.get("label", "Unknown"),
            "id": leaf.get("id"),
            "cluster": tree,           # parent is root — correct for edge resolution
            "leaves": [leaf],
            "edges": [],               # no intra-submap edges for singletons
        })

    return submaps


def _choose_submap(
        submaps: list[dict[str, Any]],
        question: str,
) -> tuple[dict[str, Any], int]:
    query_tokens = _tokens(question)
    scored = []
    for submap in submaps:
        text = " ".join([
            submap["name"],
            submap["cluster"].get("summary", ""),
            " ".join(leaf.get("label", "") for leaf in submap["leaves"]),
            " ".join(leaf.get("file_path", "") for leaf in submap["leaves"]),
        ])
        edge_count = len([
            edge for edge in submap["edges"]
            if edge.get("from") and edge.get("to") and edge.get("from") != edge.get("to")
        ])
        scored.append((_score(text, query_tokens), edge_count, len(submap["leaves"]), submap))

    scored.sort(key=lambda item: (item[0], item[1]), reverse=True)
    return scored[0][3], scored[0][0]


def _choose_leaf(submap: dict[str, Any], question: str) -> tuple[dict[str, Any], int]:
    query_tokens = _tokens(question)
    edge_mentions: dict[str, int] = {}
    for edge in submap["edges"]:
        if edge.get("from"):
            edge_mentions[edge["from"]] = edge_mentions.get(edge["from"], 0) + 1
        if edge.get("to"):
            edge_mentions[edge["to"]] = edge_mentions.get(edge["to"], 0) + 1

    scored = []
    for leaf in submap["leaves"]:
        internal_text = " ".join(
            f"{node.get('id', '')} {node.get('label', '')} {node.get('responsibility', '')}"
            for node in leaf.get("nodes", [])
        )
        text = " ".join([
            leaf.get("label", ""),
            leaf.get("file_path", ""),
            leaf.get("summary", ""),
            internal_text,
        ])
        token_score = _score(text, query_tokens)
        connectivity = edge_mentions.get(leaf.get("label"), 0)
        scored.append((token_score, connectivity, len(leaf.get("nodes", [])), leaf))

    scored.sort(key=lambda item: (item[0], item[1]), reverse=True)
    return scored[0][3], scored[0][0]


def _leaf_by_source_path(submaps: list[dict[str, Any]], source_path: str) -> tuple[dict[str, Any], dict[str, Any]] | None:
    normalized_source = _normalize_path(source_path)
    if not normalized_source:
        return None

    for submap in submaps:
        for leaf in submap["leaves"]:
            if _normalize_path(leaf.get("file_path")) == normalized_source:
                return submap, leaf
    return None


def _rag_matched_leaves(
        submaps: list[dict[str, Any]],
        sources: list[dict[str, Any]],
        min_score: float = 0.018,
) -> list[tuple[dict[str, Any], dict[str, Any]]]:
    """
    Map RAG sources back to graph leaves.

    min_score: minimum RRF score to treat a source as animation-worthy.
    RRF max per result is ~0.039. We keep this low enough to include
    secondary UI/API files from the RAG answer, while filtering docs below.
    """
    matched: list[tuple[dict[str, Any], dict[str, Any]]] = []
    seen_paths: set[str] = set()

    for source in sources:
        if source.get("score", 0) < min_score:
            continue
        path = _normalize_path(source.get("file_path"))
        if not path or path in seen_paths:
            continue
        found = _leaf_by_source_path(submaps, path)
        if found:
            _submap, leaf = found
            # Keep workflow animations code-focused. Documentation often appears
            # in low-ranked RAG sources and makes the visual tour feel random.
            if leaf.get("file_type") == "doc":
                continue
            matched.append(found)
            seen_paths.add(path)
    return matched


def _orphan_submap_names(tree: dict[str, Any], submaps: list[dict[str, Any]]) -> set[str]:
    """
    Return fake workflow submap names that represent direct root leaf nodes.

    These names are useful for grouping workflow segments, but they are not
    navigable clusters in the frontend tree. The canvas already renders those
    leaves in domain view, so segments targeting them must use
    navigate_to_submap=None.
    """
    root_leaf_labels = {
        child.get("label")
        for child in tree.get("children", [])
        if child.get("type") == "leaf"
    }
    orphan_names: set[str] = set()
    for submap in submaps:
        leaves = submap.get("leaves", [])
        if len(leaves) != 1:
            continue
        leaf = leaves[0]
        if submap.get("cluster", {}).get("type") == "cluster" and leaf.get("label") in root_leaf_labels:
            orphan_names.add(submap["name"])
    return orphan_names


def _choose_submap_from_rag(
        submaps: list[dict[str, Any]],
        matched: list[tuple[dict[str, Any], dict[str, Any]]],
        question: str,
) -> dict[str, Any]:
    if not matched:
        return _choose_submap(submaps, question)[0]

    counts: dict[str, tuple[int, dict[str, Any]]] = {}
    for submap, _leaf in matched:
        name = submap["name"]
        count, _existing = counts.get(name, (0, submap))
        counts[name] = (count + 1, submap)

    return sorted(counts.values(), key=lambda item: item[0], reverse=True)[0][1]


def _shortest_edge_path(edges: list[dict[str, str]], start: str, goal: str) -> list[str]:
    if start == goal:
        return [start]

    adjacency: dict[str, list[str]] = {}
    for edge in edges:
        source = edge.get("from")
        target = edge.get("to")
        if not source or not target or source == target:
            continue
        adjacency.setdefault(source, []).append(target)

    queue: deque[list[str]] = deque([[start]])
    seen = {start}
    while queue:
        path = queue.popleft()
        if len(path) >= 5:
            continue
        for next_node in adjacency.get(path[-1], []):
            if next_node in seen:
                continue
            next_path = [*path, next_node]
            if next_node == goal:
                return next_path
            seen.add(next_node)
            queue.append(next_path)

    return []


def _build_path_from_rag(submap: dict[str, Any], source_leaves: list[dict[str, Any]]) -> list[str]:
    """
    Build an edge path between RAG-matched leaves within a submap.

    Only traverses edges whose both endpoints are among the RAG-matched leaves.
    This prevents the fallback from picking up arbitrary submap edges that
    connect to unrelated nodes (e.g. Drop File, Deck Presentation) that happened
    to share a graph edge with a matched node.
    """
    leaf_labels = {leaf.get("label") for leaf in submap["leaves"]}

    # Only the labels that were actually RAG-matched — not all leaves in the submap.
    matched_labels = []
    seen_labels: set[str] = set()
    for leaf in source_leaves:
        label = leaf.get("label")
        if label and label in leaf_labels and label not in seen_labels:
            matched_labels.append(label)
            seen_labels.add(label)

    if len(matched_labels) < 2:
        return []

    matched_label_set = set(matched_labels)

    # Only allow edges where BOTH endpoints are RAG-matched leaves.
    # This is the key constraint that prevents spurious paths through
    # unrelated nodes that merely share a graph edge with a matched file.
    strict_edges = [
        edge for edge in submap["edges"]
        if edge.get("from") in matched_label_set
           and edge.get("to") in matched_label_set
           and edge.get("from") != edge.get("to")
    ]

    if not strict_edges:
        return []

    path = _shortest_edge_path(strict_edges, matched_labels[0], matched_labels[1])
    return path if len(path) > 1 else []


async def build_workflow_response(question: str, repo: dict[str, Any], repo_id: str, domain_id: str | None = None) -> dict[str, Any]:
    tree = repo.get("cluster_tree")
    if not isinstance(tree, dict):
        return {
            "type": "workflow_animation",
            "answer": "This repo does not have a graph tree available yet. Re-ingest it before using workflow showcase mode.",
            "confidence": "low",
            "sources": [],
            "flow": {"paths": [], "loop": False, "step_duration_ms": 1000},
        }

    rag_result = await query_repo(
        question=question,
        repo_id=repo_id,
        domain_id=None,
        top_k=8,
    )
    rag_sources = rag_result.get("sources", [])
    if not rag_sources:
        return {
            "type": "workflow_animation",
            "answer": rag_result.get("answer") or "I could not find relevant source files for that workflow request.",
            "confidence": rag_result.get("confidence", "low"),
            "sources": [],
            "flow": {"paths": [], "loop": False, "step_duration_ms": 1000},
        }

    submaps = _submaps_from_tree(tree)
    if not submaps:
        return {
            "type": "workflow_animation",
            "answer": "No workflow-ready graph nodes were found for this repo.",
            "confidence": "low",
            "sources": [],
            "flow": {"paths": [], "loop": False, "step_duration_ms": 1000},
        }

    matched = _rag_matched_leaves(submaps, rag_sources)
    if not matched:
        return {
            "type": "workflow_animation",
            "answer": (
                f"{rag_result.get('answer') or 'I found related code, but could not map the retrieved sources to graph nodes.'}\n\n"
                "No graph animation was triggered because the retrieved source files do not match this graph."
            ),
            "confidence": "low",
            "sources": rag_sources,
            "flow": {"paths": [], "loop": False, "step_duration_ms": 1000},
        }

    # Build one segment per matched leaf, grouped by submap.
    # Each segment navigates to a submap, zooms to a file, and plays its internals.
    # Cross-file paths within a submap are threaded through the segment's paths field.
    #
    # We cap at 4 segments to keep the animation under ~20 seconds.
    MAX_SEGMENTS = 4

    segments: list[dict[str, Any]] = []
    seen_leaf_labels: set[str] = set()

    # Group matched leaves by submap.
    # Each group also tracks the cumulative RAG score of its leaves so we can
    # rank submaps by actual retrieval relevance rather than token overlap.
    # A submap with one high-score file should rank above one with three low-score files.
    submap_groups: dict[str, list[dict[str, Any]]] = {}
    submap_score: dict[str, float] = {}

    # Build a score lookup from sources so we can attribute scores to matched leaves.
    source_score_by_path: dict[str, float] = {
        _normalize_path(s.get("file_path", "")): s.get("score", 0)
        for s in rag_sources
    }

    for matched_submap, leaf in matched:
        key = str(matched_submap.get("id") or matched_submap["name"])
        submap_groups.setdefault(key, []).append(leaf)
        leaf_score = source_score_by_path.get(_normalize_path(leaf.get("file_path", "")), 0)
        submap_score[key] = submap_score.get(key, 0) + leaf_score

    # Sort by cumulative RAG score descending — most relevant submap animates first.
    ordered_groups = sorted(
        submap_groups.items(),
        key=lambda item: submap_score.get(item[0], 0),
        reverse=True,
    )

    # Keep only the top 2 submaps. Animating across 3+ submaps makes the
    # experience noisy and the later segments are usually low-relevance noise.
    MAX_SUBMAPS = 2
    ordered_groups = ordered_groups[:MAX_SUBMAPS]

    # Find the submap dict by stable ID when available. Labels are not unique.
    submap_by_key: dict[str, dict[str, Any]] = {
        str(sm.get("id") or sm["name"]): sm
        for sm in submaps
    }
    orphan_submap_names = _orphan_submap_names(tree, submaps)

    for submap_key, leaves in ordered_groups:
        if len(segments) >= MAX_SEGMENTS:
            break

        submap = submap_by_key.get(submap_key)
        if not submap:
            continue
        submap_name = submap["name"]
        submap_id = submap.get("id")

        # Build intra-submap path across all leaves in this group.
        path = _build_path_from_rag(submap, leaves) if len(leaves) > 1 else []

        for leaf in leaves:
            if len(segments) >= MAX_SEGMENTS:
                break
            label = leaf.get("label")
            if not label or label in seen_leaf_labels:
                continue
            seen_leaf_labels.add(label)

            internal_steps = [
                node.get("id")
                for node in leaf.get("nodes", [])
                if isinstance(node.get("id"), str) and node.get("id")
            ][:5]

            segment: dict[str, Any] = {
                "navigate_to_submap": None if submap_name in orphan_submap_names else submap_name,
                "navigate_to_submap_id": None if submap_name in orphan_submap_names else submap_id,
                "zoom_to_node": label,
                "paths": [],
                "loop": False,
                "step_duration_ms": 1000,
            }

            # Attach the cross-leaf path only to the first leaf in the group
            # so the animation flows through all files before zooming into each one.
            if path and len(path) > 1 and label == leaves[0].get("label"):
                segment["paths"] = [path]

            if internal_steps:
                segment["internal_flow"] = {
                    "node_label": label,
                    "steps": internal_steps,
                }

            segments.append(segment)

    if not segments:
        return {
            "type": "workflow_animation",
            "answer": (
                f"{rag_result.get('answer') or 'I found related code, but not an animatable graph path.'}\n\n"
                "No graph animation was triggered because the relevant files do not expose a reliable path or internal flow in the graph."
            ),
            "confidence": rag_result.get("confidence", "low"),
            "sources": rag_sources,
            "flow": {"segments": [], "paths": [], "loop": False, "step_duration_ms": 1000},
        }

    # Legacy single-segment fields: use the first segment so older frontend versions
    # still get a valid (if incomplete) animation payload.
    first = segments[0]

    return {
        "type": "workflow_animation",
        "answer": rag_result.get("answer") or (
            f"Workflow showcase prepared across {len(segments)} file(s). "
            f"Starting at {first.get('navigate_to_submap')} → {first.get('zoom_to_node')}."
        ),
        "confidence": rag_result.get("confidence", "medium"),
        "sources": rag_sources,
        "flow": {
            # Multi-segment field — frontend iterates these in order.
            "segments": segments,
            # Legacy single-segment fields for backward compatibility.
            "navigate_to_submap": first.get("navigate_to_submap"),
            "navigate_to_submap_id": first.get("navigate_to_submap_id"),
            "zoom_to_node": first.get("zoom_to_node"),
            "paths": first.get("paths", []),
            "internal_flow": first.get("internal_flow"),
            "loop": False,
            "step_duration_ms": 1000,
        },
    }
