"""
workflow.py - deterministic workflow showcase builder.

This service builds animation payloads from the stored cluster tree. It does
not call an LLM; it chooses exact graph labels so the frontend animation has
stable node IDs to target during demos.
"""

from __future__ import annotations

import re
from typing import Any


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


def _find_node_by_id(node: dict[str, Any], node_id: str) -> dict[str, Any] | None:
    if node.get("id") == node_id:
        return node
    for child in node.get("children", []):
        found = _find_node_by_id(child, node_id)
        if found:
            return found
    return None


def _submaps_from_tree(tree: dict[str, Any]) -> list[dict[str, Any]]:
    if tree.get("type") == "leaf":
        return [{
            "name": tree.get("label", "Repository"),
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
            "cluster": tree,
            "leaves": _collect_leaves(tree),
            "edges": _collect_cluster_edges(tree),
        }]

    submaps = [
        {
            "name": cluster.get("label", "Cluster"),
            "cluster": cluster,
            "leaves": _collect_leaves(cluster),
            "edges": _collect_cluster_edges(cluster),
        }
        for cluster in cluster_children
    ]

    if leaf_children:
        submaps.append({
            "name": "Project Root",
            "cluster": tree,
            "leaves": leaf_children,
            "edges": list(tree.get("edges", [])),
        })

    return submaps


def _choose_submap(
    tree: dict[str, Any],
    submaps: list[dict[str, Any]],
    question: str,
    domain_id: str | None,
) -> dict[str, Any]:
    if domain_id:
        scoped = _find_node_by_id(tree, domain_id)
        if scoped:
            scoped_leaves = {leaf.get("label") for leaf in _collect_leaves(scoped)}
            for submap in submaps:
                submap_leaves = {leaf.get("label") for leaf in submap["leaves"]}
                if scoped.get("label") == submap["name"] or scoped_leaves & submap_leaves:
                    return submap

    query_tokens = _tokens(question)
    scored = []
    for submap in submaps:
        text = " ".join([
            submap["name"],
            submap["cluster"].get("summary", ""),
            " ".join(leaf.get("label", "") for leaf in submap["leaves"]),
            " ".join(leaf.get("file_path", "") for leaf in submap["leaves"]),
        ])
        scored.append((_score(text, query_tokens), len(submap["leaves"]), submap))

    scored.sort(key=lambda item: (item[0], item[1]), reverse=True)
    return scored[0][2]


def _choose_leaf(submap: dict[str, Any], question: str) -> dict[str, Any]:
    query_tokens = _tokens(question)
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
        scored.append((_score(text, query_tokens), len(leaf.get("nodes", [])), leaf))

    scored.sort(key=lambda item: (item[0], item[1]), reverse=True)
    return scored[0][2]


def _build_path(submap: dict[str, Any], target_leaf: dict[str, Any]) -> list[str]:
    leaf_labels = {leaf.get("label") for leaf in submap["leaves"]}
    usable_edges = [
        edge for edge in submap["edges"]
        if edge.get("from") in leaf_labels and edge.get("to") in leaf_labels and edge.get("from") != edge.get("to")
    ]

    if usable_edges:
        path = [target_leaf.get("label")]
        seen = set(path)
        while len(path) < 5:
            next_edge = next((edge for edge in usable_edges if edge.get("from") == path[-1] and edge.get("to") not in seen), None)
            if not next_edge:
                break
            path.append(next_edge["to"])
            seen.add(next_edge["to"])
        if len(path) > 1:
            return path

        containing = next((edge for edge in usable_edges if target_leaf.get("label") in (edge.get("from"), edge.get("to"))), None)
        if containing:
            return [containing["from"], containing["to"]]

    labels = [leaf.get("label") for leaf in submap["leaves"] if leaf.get("label")]
    if target_leaf.get("label") in labels:
        labels.remove(target_leaf["label"])
        labels.insert(0, target_leaf["label"])
    return labels[: min(4, len(labels))]


def build_workflow_response(question: str, repo: dict[str, Any], domain_id: str | None = None) -> dict[str, Any]:
    tree = repo.get("cluster_tree")
    if not isinstance(tree, dict):
        return {
            "type": "workflow_animation",
            "answer": "This repo does not have a graph tree available yet. Re-ingest it before using workflow showcase mode.",
            "confidence": "low",
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

    submap = _choose_submap(tree, submaps, question, domain_id)
    target_leaf = _choose_leaf(submap, question)
    path = _build_path(submap, target_leaf)
    internal_steps = [
        node.get("id")
        for node in target_leaf.get("nodes", [])
        if isinstance(node.get("id"), str) and node.get("id")
    ][:5]

    flow: dict[str, Any] = {
        "navigate_to_submap": submap["name"],
        "zoom_to_node": target_leaf.get("label"),
        "paths": [path] if len(path) > 1 else [],
        "loop": False,
        "step_duration_ms": 1000,
    }
    if internal_steps:
        flow["internal_flow"] = {
            "node_label": target_leaf.get("label"),
            "steps": internal_steps,
        }

    source = {
        "chunk_id": str(target_leaf.get("id") or target_leaf.get("file_path") or target_leaf.get("label")),
        "file_path": target_leaf.get("file_path", ""),
        "domain_id": str(target_leaf.get("id")) if target_leaf.get("id") else None,
        "score": 1.0,
        "summary": target_leaf.get("summary", ""),
    }

    return {
        "type": "workflow_animation",
        "answer": (
            f"Workflow showcase prepared for {submap['name']}. "
            f"It focuses on {target_leaf.get('label')} and then follows the visible file-level path."
        ),
        "confidence": "high" if len(path) > 1 or internal_steps else "medium",
        "sources": [source],
        "flow": flow,
    }
