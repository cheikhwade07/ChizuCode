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
    idx = _next_key_index()
    client = _gemini_clients[idx]
    sem = _emb_semaphores[idx]

    async with sem:
        try:
            result = await asyncio.wait_for(
                asyncio.to_thread(
                    client.models.embed_content,
                    model=GEMINI_EMBED_MODEL,
                    contents=summary,
                    config=types.EmbedContentConfig(
                        task_type="RETRIEVAL_DOCUMENT",
                        output_dimensionality=1536,
                    ),
                ),
                timeout=GEMINI_EMBED_TIMEOUT_SECONDS,
            )
            return result.embeddings[0].values
        except asyncio.TimeoutError:
            logger.warning("summary embed timed out (key %d)", idx)
            return None
        except Exception as e:
            logger.warning("summary embed failed (key %d): %s", idx, e)
            return None


async def _embed_code(raw_code: str) -> list[float] | None:
    text = _truncate(raw_code, MAX_EMBED_INPUT_CHARS)
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
            return result.embeddings[0]
        except asyncio.TimeoutError:
            logger.warning("code embed timed out")
            return None
        except Exception as e:
            logger.warning("code embed failed: %s", e)
            return None


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
        batch_results = await asyncio.gather(*(process_chunk(c) for c in batch))
        results.extend(batch_results)

    return results
