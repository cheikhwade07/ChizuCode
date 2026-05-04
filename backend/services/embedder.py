"""
embedder.py — summarize chunks and produce both vectors.

For each chunk this module:
  1. Generates a plain-language summary via Gemini (text generation)
  2. Embeds the summary via Gemini (semantic vector for clustering)
  3. Embeds the raw code via Voyage (syntactic vector for RAG retrieval)

Multiple Gemini API keys are round-robined to multiply effective rate limits.
Set GEMINI_API_KEY_1, GEMINI_API_KEY_2, ... in your .env (falls back to GEMINI_API_KEY).

Dependencies:
    pip install google-genai voyageai python-dotenv
"""

from __future__ import annotations

import asyncio
import hashlib
import itertools
import logging
import os

import voyageai
from dotenv import load_dotenv
from google import genai
from google.genai import types

load_dotenv()
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

VOYAGE_API_KEY = os.getenv("VOYAGE_API_KEY")
if not VOYAGE_API_KEY:
    raise RuntimeError("VOYAGE_API_KEY is not set")

# Collect all Gemini API keys — GEMINI_API_KEY_1, _2, _3, ... or fallback to GEMINI_API_KEY
def _load_gemini_keys() -> list[str]:
    keys = []
    # numbered keys first
    for i in range(1, 20):
        k = os.getenv(f"GEMINI_API_KEY_{i}")
        if k:
            keys.append(k)
    # fallback to base key
    if not keys:
        base = os.getenv("GEMINI_API_KEY")
        if not base:
            raise RuntimeError("No Gemini API key found. Set GEMINI_API_KEY or GEMINI_API_KEY_1, _2, ...")
        keys.append(base)
    logger.info("Loaded %d Gemini API key(s)", len(keys))
    return keys

_GEMINI_KEYS = _load_gemini_keys()

# One client + one semaphore per key
_gemini_clients  = [genai.Client(api_key=k) for k in _GEMINI_KEYS]
_gen_semaphores  = [asyncio.Semaphore(20) for _ in _GEMINI_KEYS]
_emb_semaphores  = [asyncio.Semaphore(20) for _ in _GEMINI_KEYS]

# Round-robin counter — itertools.cycle is thread-safe for reads
_key_cycle = itertools.cycle(range(len(_GEMINI_KEYS)))

def _next_key_index() -> int:
    return next(_key_cycle)

_voyage_client = voyageai.AsyncClient(api_key=VOYAGE_API_KEY)
_VOYAGE_SEMAPHORE = asyncio.Semaphore(10)

GEMINI_GENERATE_MODEL = "gemini-2.5-flash-lite"
GEMINI_EMBED_MODEL    = "gemini-embedding-001"
VOYAGE_CODE_MODEL     = "voyage-code-2"

MAX_SUMMARY_INPUT_CHARS = 12_000
MAX_EMBED_INPUT_CHARS   = 30_000
GEMINI_GENERATE_TIMEOUT_SECONDS = int(os.getenv("GEMINI_GENERATE_TIMEOUT_SECONDS", "45"))
GEMINI_EMBED_TIMEOUT_SECONDS = int(os.getenv("GEMINI_EMBED_TIMEOUT_SECONDS", "45"))
VOYAGE_EMBED_TIMEOUT_SECONDS = int(os.getenv("VOYAGE_EMBED_TIMEOUT_SECONDS", "45"))
INGEST_BATCH_SIZE = int(os.getenv("INGEST_BATCH_SIZE", "40"))
GEMINI_SUMMARY_BATCH_SIZE = max(1, int(os.getenv("GEMINI_SUMMARY_BATCH_SIZE", "20")))
VOYAGE_CODE_BATCH_SIZE = max(1, int(os.getenv("VOYAGE_CODE_BATCH_SIZE", "20")))
EMBED_CACHE_MAX_ITEMS = max(0, int(os.getenv("EMBED_CACHE_MAX_ITEMS", "2000")))

_summary_vector_cache: dict[str, list[float]] = {}
_code_vector_cache: dict[str, list[float]] = {}


# ---------------------------------------------------------------------------
# Prompt
# ---------------------------------------------------------------------------

_SUMMARY_PROMPT = """\
You are summarizing a source file for semantic search and domain clustering.

File path: {file_path}
Language:  {language}
File type: {file_type}

Summarize in 3-5 sentences. Focus on:
- What domain or business concern this file addresses
- Its primary responsibility
- What other parts of the system it likely interacts with

Do not describe syntax or implementation details. Describe purpose and domain.
Output the summary directly with no preamble.

--- BEGIN FILE ---
{content}
--- END FILE ---
"""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _truncate(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + "\n... [truncated]"


def _cache_key(model: str, text: str) -> str:
    return hashlib.sha256(f"{model}\0{text}".encode("utf-8")).hexdigest()


def _cache_get(cache: dict[str, list[float]], key: str) -> list[float] | None:
    return cache.get(key)


def _cache_set(cache: dict[str, list[float]], key: str, value: list[float] | None) -> None:
    if value is None or EMBED_CACHE_MAX_ITEMS <= 0:
        return
    if len(cache) >= EMBED_CACHE_MAX_ITEMS:
        cache.pop(next(iter(cache)))
    cache[key] = value


def _fallback_summary(chunk: dict) -> str:
    return (
        f"File: {chunk['file_path']} "
        f"({chunk.get('language') or 'unknown'}, {chunk['file_type']}). "
        f"Summary unavailable."
    )


async def _summarize(chunk: dict) -> str:
    content = _truncate(chunk["content"], MAX_SUMMARY_INPUT_CHARS)
    prompt = _SUMMARY_PROMPT.format(
        file_path=chunk["file_path"],
        language=chunk.get("language") or "unknown",
        file_type=chunk["file_type"],
        content=content,
    )

    idx = _next_key_index()
    client = _gemini_clients[idx]
    sem = _gen_semaphores[idx]

    async with sem:
        for attempt in range(3):
            try:
                response = await asyncio.wait_for(
                    client.aio.models.generate_content(
                        model=GEMINI_GENERATE_MODEL,
                        contents=prompt,
                    ),
                    timeout=GEMINI_GENERATE_TIMEOUT_SECONDS,
                )
                text = (response.text or "").strip()
                return text if text else _fallback_summary(chunk)
            except asyncio.TimeoutError:
                if attempt < 2:
                    logger.warning("summary timed out for %s (key %d)", chunk["file_path"], idx)
                    await asyncio.sleep(2 ** attempt)
                else:
                    logger.warning("all summary timeout retries failed for %s (key %d)", chunk["file_path"], idx)
                    return _fallback_summary(chunk)
            except Exception as e:
                if attempt < 2:
                    wait = 2 ** attempt
                    logger.warning("retry %d for %s (key %d): %s", attempt + 1, chunk["file_path"], idx, e)
                    await asyncio.sleep(wait)
                else:
                    logger.warning("all retries failed for %s (key %d): %s", chunk["file_path"], idx, e)
                    return _fallback_summary(chunk)


async def _embed_summary(summary: str) -> list[float] | None:
    text = _truncate(summary, MAX_EMBED_INPUT_CHARS)
    cache_key = _cache_key(GEMINI_EMBED_MODEL, text)
    cached = _cache_get(_summary_vector_cache, cache_key)
    if cached is not None:
        return cached

    idx = _next_key_index()
    client = _gemini_clients[idx]
    sem = _emb_semaphores[idx]

    async with sem:
        try:
            result = await asyncio.wait_for(
                asyncio.to_thread(
                    client.models.embed_content,
                    model=GEMINI_EMBED_MODEL,
                    contents=text,
                    config=types.EmbedContentConfig(
                        task_type="RETRIEVAL_DOCUMENT",
                        output_dimensionality=1536,
                    ),
                ),
                timeout=GEMINI_EMBED_TIMEOUT_SECONDS,
            )
            vector = result.embeddings[0].values
            _cache_set(_summary_vector_cache, cache_key, vector)
            return vector
        except asyncio.TimeoutError:
            logger.warning("summary embed timed out (key %d)", idx)
            return None
        except Exception as e:
            logger.warning("summary embed failed (key %d): %s", idx, e)
            return None


async def _embed_summary_batch(summaries: list[str]) -> list[list[float] | None]:
    """
    Embed summaries in Gemini request batches.
    Falls back to single-summary calls if batched embedding is unavailable.
    """
    if not summaries:
        return []

    results: list[list[float] | None] = [None] * len(summaries)
    uncached_indices: list[int] = []
    uncached_texts: list[str] = []

    for idx, summary in enumerate(summaries):
        text = _truncate(summary, MAX_EMBED_INPUT_CHARS)
        cache_key = _cache_key(GEMINI_EMBED_MODEL, text)
        cached = _cache_get(_summary_vector_cache, cache_key)
        if cached is not None:
            results[idx] = cached
        else:
            uncached_indices.append(idx)
            uncached_texts.append(text)

    for start in range(0, len(uncached_texts), GEMINI_SUMMARY_BATCH_SIZE):
        batch_texts = uncached_texts[start:start + GEMINI_SUMMARY_BATCH_SIZE]
        batch_indices = uncached_indices[start:start + GEMINI_SUMMARY_BATCH_SIZE]
        idx = _next_key_index()
        client = _gemini_clients[idx]
        sem = _emb_semaphores[idx]

        async with sem:
            try:
                result = await asyncio.wait_for(
                    asyncio.to_thread(
                        client.models.embed_content,
                        model=GEMINI_EMBED_MODEL,
                        contents=batch_texts,
                        config=types.EmbedContentConfig(
                            task_type="RETRIEVAL_DOCUMENT",
                            output_dimensionality=1536,
                        ),
                    ),
                    timeout=GEMINI_EMBED_TIMEOUT_SECONDS,
                )
                if len(result.embeddings) != len(batch_texts):
                    raise ValueError(
                        f"expected {len(batch_texts)} embeddings, got {len(result.embeddings)}"
                    )
                for result_idx, text, embedding in zip(batch_indices, batch_texts, result.embeddings):
                    vector = embedding.values
                    results[result_idx] = vector
                    _cache_set(_summary_vector_cache, _cache_key(GEMINI_EMBED_MODEL, text), vector)
                continue
            except asyncio.TimeoutError:
                logger.warning("summary embed batch timed out for %d text(s); falling back", len(batch_texts))
            except Exception as e:
                logger.warning("summary embed batch failed for %d text(s); falling back: %s", len(batch_texts), e)

        fallback_vectors = await asyncio.gather(*(_embed_summary(text) for text in batch_texts))
        for result_idx, vector in zip(batch_indices, fallback_vectors):
            results[result_idx] = vector

    return results


async def _embed_code_single(raw_code: str) -> list[float] | None:
    text = _truncate(raw_code, MAX_EMBED_INPUT_CHARS)
    cache_key = _cache_key(VOYAGE_CODE_MODEL, text)
    cached = _cache_get(_code_vector_cache, cache_key)
    if cached is not None:
        return cached

    async with _VOYAGE_SEMAPHORE:
        try:
            result = await asyncio.wait_for(
                _voyage_client.embed(
                    texts=[text],
                    model=VOYAGE_CODE_MODEL,
                    input_type="document",
                ),
                timeout=VOYAGE_EMBED_TIMEOUT_SECONDS,
            )
            vector = result.embeddings[0]
            _cache_set(_code_vector_cache, cache_key, vector)
            return vector
        except asyncio.TimeoutError:
            logger.warning("code embed timed out")
            return None
        except Exception as e:
            logger.warning("code embed failed: %s", e)
            return None


async def _embed_code_batch(raw_codes: list[str]) -> list[list[float] | None]:
    """
    Embed raw code with Voyage in request batches.
    Falls back to per-text calls if a batch is rejected or times out.
    """
    if not raw_codes:
        return []

    results: list[list[float] | None] = [None] * len(raw_codes)
    uncached_indices: list[int] = []
    uncached_texts: list[str] = []

    for idx, raw_code in enumerate(raw_codes):
        text = _truncate(raw_code, MAX_EMBED_INPUT_CHARS)
        cache_key = _cache_key(VOYAGE_CODE_MODEL, text)
        cached = _cache_get(_code_vector_cache, cache_key)
        if cached is not None:
            results[idx] = cached
        else:
            uncached_indices.append(idx)
            uncached_texts.append(text)

    for start in range(0, len(uncached_texts), VOYAGE_CODE_BATCH_SIZE):
        batch_texts = uncached_texts[start:start + VOYAGE_CODE_BATCH_SIZE]
        batch_indices = uncached_indices[start:start + VOYAGE_CODE_BATCH_SIZE]

        async with _VOYAGE_SEMAPHORE:
            try:
                result = await asyncio.wait_for(
                    _voyage_client.embed(
                        texts=batch_texts,
                        model=VOYAGE_CODE_MODEL,
                        input_type="document",
                    ),
                    timeout=VOYAGE_EMBED_TIMEOUT_SECONDS,
                )
                if len(result.embeddings) != len(batch_texts):
                    raise ValueError(
                        f"expected {len(batch_texts)} embeddings, got {len(result.embeddings)}"
                    )
                for result_idx, text, vector in zip(batch_indices, batch_texts, result.embeddings):
                    results[result_idx] = vector
                    _cache_set(_code_vector_cache, _cache_key(VOYAGE_CODE_MODEL, text), vector)
                continue
            except asyncio.TimeoutError:
                logger.warning("code embed batch timed out for %d text(s); falling back", len(batch_texts))
            except Exception as e:
                logger.warning("code embed batch failed for %d text(s); falling back: %s", len(batch_texts), e)

        fallback_vectors = await asyncio.gather(*(_embed_code_single(text) for text in batch_texts))
        for result_idx, vector in zip(batch_indices, fallback_vectors):
            results[result_idx] = vector

    return results


async def _embed_code(raw_code: str) -> list[float] | None:
    return await _embed_code_single(raw_code)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

async def process_chunk(chunk: dict) -> dict:
    """
    Summarize + embed a single chunk.
    Returns the chunk dict augmented with summary, summary_vector, code_vector.
    """
    summary = await _summarize(chunk)

    summary_vector, code_vector = await asyncio.gather(
        _embed_summary(summary),
        _embed_code(chunk["content"]),
    )

    return {
        **chunk,
        "summary": summary,
        "summary_vector": summary_vector,
        "code_vector": code_vector,
    }


async def process_chunks(chunks: list[dict], batch_size: int = INGEST_BATCH_SIZE) -> list[dict]:
    """
    Process chunks in batches to avoid memory pressure.
    Order of results matches order of input.
    """
    results = []
    total = len(chunks)

    for i in range(0, total, batch_size):
        batch = chunks[i: i + batch_size]
        logger.info(
            "processing chunks %d-%d of %d",
            i + 1, min(i + batch_size, total), total,
            )
        summaries = await asyncio.gather(*(_summarize(c) for c in batch))
        summary_vectors = await _embed_summary_batch(summaries)
        code_vectors = await _embed_code_batch([c["content"] for c in batch])

        batch_results = [
            {
                **chunk,
                "summary": summaries[idx],
                "summary_vector": summary_vectors[idx],
                "code_vector": code_vectors[idx],
            }
            for idx, chunk in enumerate(batch)
        ]
        results.extend(batch_results)

    return results
