"""
rag.py — RAG query service.

Pipeline per query:
  1. Embed the question via Gemini (summary) + Voyage (code)
  2. Search summary_vectors and code_vectors independently (top-k each)
  3. Merge results with Reciprocal Rank Fusion (k=50)
  4. Relevance threshold — reject if top score too low
  5. Send top chunks + question to Gemini for answer synthesis
  6. Validate response format before returning

Response shape:
  {
    "answer": str,
    "confidence": "high" | "medium" | "low",
    "sources": [
      {
        "chunk_id": str,
        "file_path": str,
        "domain_id": str | None,
        "score": float,
        "summary": str
      }
    ]
  }

Dependencies: google-genai, voyageai (already installed)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re

import voyageai
from dotenv import load_dotenv
from google import genai
from google.genai import types

from backend.db.database import search_summary_vectors, search_code_vectors

load_dotenv()
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
VOYAGE_API_KEY = os.getenv("VOYAGE_API_KEY")

if not GEMINI_API_KEY:
    raise RuntimeError("GEMINI_API_KEY is not set")
if not VOYAGE_API_KEY:
    raise RuntimeError("VOYAGE_API_KEY is not set")

_gemini = genai.Client(api_key=GEMINI_API_KEY)
_voyage = voyageai.AsyncClient(api_key=VOYAGE_API_KEY)

GEMINI_EMBED_MODEL   = "gemini-embedding-001"
GEMINI_GENERATE_MODEL = "gemini-2.5-flash-lite"
VOYAGE_CODE_MODEL    = "voyage-code-2"

# RRF constant — higher k = less weight to top ranks
RRF_K = 50

# How many results to fetch from each vector search before merging
SEARCH_TOP_K = 10

# How many top chunks to send to Gemini for answer generation
CONTEXT_TOP_K = 5

# Minimum RRF score to consider a result relevant
# RRF max per result = 1/(50+1) + 1/(50+1) ≈ 0.039
# A score below 0.01 means the chunk ranked very low in both searches
RELEVANCE_THRESHOLD = 0.01

_SEMAPHORE = asyncio.Semaphore(5)


# ---------------------------------------------------------------------------
# Prompt
# ---------------------------------------------------------------------------

_RAG_PROMPT = """
You are an expert code assistant helping a developer understand a codebase.

Answer the question below using ONLY the provided code context.
If the context does not contain enough information to answer, say so clearly.

Question: {question}

--- CONTEXT ---
{context}
--- END CONTEXT ---

Return ONLY valid JSON with no preamble or markdown fences. Schema:
{{
  "answer": "your detailed answer here",
  "confidence": "high" | "medium" | "low"
}}

Confidence guide:
- high   : context directly and clearly answers the question
- medium : context partially answers or requires some inference
- low    : context is loosely related, answer may be incomplete
"""


# ---------------------------------------------------------------------------
# Step 1 — Embed the query (both vectors)
# ---------------------------------------------------------------------------

async def _embed_query(question: str) -> tuple[list[float] | None, list[float] | None]:
    """
    Embed query with both Gemini (semantic) and Voyage (syntactic).
    Returns (summary_vector, code_vector) — either can be None on failure.
    """
    async def _gemini_embed():
        try:
            result = await asyncio.to_thread(
                _gemini.models.embed_content,
                model=GEMINI_EMBED_MODEL,
                contents=question,
                config=types.EmbedContentConfig(
                    task_type="RETRIEVAL_QUERY",
                    output_dimensionality=1536,
                ),
            )
            return result.embeddings[0].values
        except Exception as e:
            logger.warning("query summary embed failed: %s", e)
            return None

    async def _voyage_embed():
        try:
            result = await _voyage.embed(
                texts=[question],
                model=VOYAGE_CODE_MODEL,
                input_type="query",
            )
            return result.embeddings[0]
        except Exception as e:
            logger.warning("query code embed failed: %s", e)
            return None

    summary_vector, code_vector = await asyncio.gather(
        _gemini_embed(),
        _voyage_embed(),
    )
    return summary_vector, code_vector


# ---------------------------------------------------------------------------
# Step 2 — RRF merge
# ---------------------------------------------------------------------------

def _rrf_merge(
    summary_results: list[dict],
    code_results: list[dict],
    k: int = RRF_K,
) -> list[dict]:
    """
    Merge two ranked result lists using Reciprocal Rank Fusion.

    RRF score = 1/(k + rank_summary) + 1/(k + rank_code)
    Chunks only in one list get 0 for the missing rank contribution.
    Returns merged list sorted by RRF score descending.
    """
    scores: dict[str, float] = {}
    metadata: dict[str, dict] = {}

    for rank, result in enumerate(summary_results, start=1):
        cid = str(result["chunk_id"])
        scores[cid] = scores.get(cid, 0) + 1 / (k + rank)
        metadata[cid] = result

    for rank, result in enumerate(code_results, start=1):
        cid = str(result["chunk_id"])
        scores[cid] = scores.get(cid, 0) + 1 / (k + rank)
        if cid not in metadata:
            metadata[cid] = result

    merged = [
        {**metadata[cid], "score": round(score, 6)}
        for cid, score in sorted(scores.items(), key=lambda x: x[1], reverse=True)
    ]
    return merged


# ---------------------------------------------------------------------------
# Step 3 — Answer synthesis
# ---------------------------------------------------------------------------

async def _synthesize_answer(question: str, chunks: list[dict]) -> dict:
    """
    Send top chunks to Gemini and get a structured answer.
    Returns validated dict with answer + confidence.
    Falls back to a safe default if format validation fails.
    """
    context_parts = []
    for i, chunk in enumerate(chunks, start=1):
        context_parts.append(
            f"[{i}] File: {chunk['file_path']}\n"
            f"Summary: {chunk.get('summary', 'N/A')}\n"
            f"Code:\n{chunk.get('raw_code', '')[:2000]}"
        )
    context = "\n\n".join(context_parts)

    prompt = _RAG_PROMPT.format(question=question, context=context)

    async with _SEMAPHORE:
        for attempt in range(3):
            try:
                response = await _gemini.aio.models.generate_content(
                    model=GEMINI_GENERATE_MODEL,
                    contents=prompt,
                    config=types.GenerateContentConfig(temperature=0.1),
                )
                text = (response.text or "").strip()
                text = re.sub(r"^```json\s*", "", text)
                text = re.sub(r"\s*```$", "", text)

                parsed = json.loads(text)

                # Format validation
                assert isinstance(parsed.get("answer"), str) and parsed["answer"], \
                    "answer must be a non-empty string"
                assert parsed.get("confidence") in ("high", "medium", "low"), \
                    "confidence must be high | medium | low"

                return parsed

            except (json.JSONDecodeError, AssertionError) as e:
                logger.warning("format validation failed attempt %d: %s", attempt + 1, e)
                if attempt == 2:
                    # Safe fallback — still structured, just flagged
                    return {
                        "answer": "I found relevant code but encountered an issue formatting the response. Please try rephrasing your question.",
                        "confidence": "low",
                    }
            except Exception as e:
                wait = 2 ** attempt
                logger.warning("Gemini generate failed attempt %d: %s", attempt + 1, e)
                if attempt == 2:
                    return {
                        "answer": "An error occurred while generating the answer.",
                        "confidence": "low",
                    }
                await asyncio.sleep(wait)

    return {"answer": "Failed to generate answer.", "confidence": "low"}


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

async def query_repo(
    question: str,
    repo_id: str,
    domain_id: str | None = None,
    top_k: int = CONTEXT_TOP_K,
) -> dict:
    """
    Full RAG pipeline for a single question.

    Args:
        question:  natural language question from the user
        repo_id:   which repo to search
        domain_id: optional — scope search to a specific domain cluster
        top_k:     how many chunks to send to Gemini as context

    Returns:
        {
            "answer": str,
            "confidence": "high" | "medium" | "low",
            "sources": [
                {
                    "chunk_id": str,
                    "file_path": str,
                    "domain_id": str | None,
                    "score": float,
                    "summary": str
                }
            ]
        }
    """
    # ── 1. Embed query ───────────────────────────────────────────────────
    logger.info("embedding query: %s", question[:80])
    summary_vector, code_vector = await _embed_query(question)

    if summary_vector is None and code_vector is None:
        return {
            "answer": "Failed to embed your question. Please try again.",
            "confidence": "low",
            "sources": [],
        }

    # ── 2. Vector search ─────────────────────────────────────────────────
    summary_results, code_results = await asyncio.gather(
        asyncio.to_thread(
            search_summary_vectors,
            summary_vector or code_vector,
            repo_id,
            domain_id,
            SEARCH_TOP_K,
        ),
        asyncio.to_thread(
            search_code_vectors,
            code_vector or summary_vector,
            repo_id,
            domain_id,
            SEARCH_TOP_K,
        ),
    )

    # ── 3. RRF merge ─────────────────────────────────────────────────────
    merged = _rrf_merge(summary_results, code_results)

    if not merged:
        return {
            "answer": "No relevant code found for your question.",
            "confidence": "low",
            "sources": [],
        }

    # ── 4. Relevance threshold ───────────────────────────────────────────
    top_score = merged[0]["score"]
    if top_score < RELEVANCE_THRESHOLD:
        logger.info("query rejected — top RRF score %.4f below threshold", top_score)
        return {
            "answer": "Your question doesn't seem to be related to this codebase. Try asking about specific files, functions, or features.",
            "confidence": "low",
            "sources": [],
        }

    # ── 5. Build context + synthesize answer ─────────────────────────────
    context_chunks = merged[:top_k]
    synthesized = await _synthesize_answer(question, context_chunks)

    # ── 6. Build sources list ─────────────────────────────────────────────
    sources = [
        {
            "chunk_id": str(chunk["chunk_id"]),
            "file_path": chunk["file_path"],
            "domain_id": str(chunk["domain_id"]) if chunk.get("domain_id") else None,
            "score": chunk["score"],
            "summary": chunk.get("summary", ""),
        }
        for chunk in context_chunks
    ]

    return {
        "answer": synthesized["answer"],
        "confidence": synthesized["confidence"],
        "sources": sources,
    }
