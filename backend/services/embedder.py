"""
embedder.py — summarize chunks and produce both vectors.

For each chunk this module:
  1. Generates a plain-language summary via Gemini (text generation)
  2. Embeds the summary via Gemini (semantic vector for clustering)
  3. Embeds the raw code via Voyage (syntactic vector for RAG retrieval)

Dependencies:
    pip install google-genai voyageai python-dotenv
"""

from __future__ import annotations

import asyncio
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

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
VOYAGE_API_KEY = os.getenv("VOYAGE_API_KEY")

if not GEMINI_API_KEY:
    raise RuntimeError("GEMINI_API_KEY is not set")
if not VOYAGE_API_KEY:
    raise RuntimeError("VOYAGE_API_KEY is not set")

# New SDK — single client, model specified per call
_gemini_client = genai.Client(api_key=GEMINI_API_KEY)
_voyage_client  = voyageai.AsyncClient(api_key=VOYAGE_API_KEY)

GEMINI_GENERATE_MODEL = "gemini-2.5-flash-lite"
GEMINI_EMBED_MODEL    = "gemini-embedding-001"   # stable, current
VOYAGE_CODE_MODEL     = "voyage-code-2"

MAX_SUMMARY_INPUT_CHARS = 12_000  # ~3K tokens
MAX_EMBED_INPUT_CHARS   = 30_000  # voyage-code-2 supports 16K tokens

# Semaphores — separate per endpoint
_GEMINI_GENERATE_SEMAPHORE = asyncio.Semaphore(20)
_GEMINI_EMBED_SEMAPHORE    = asyncio.Semaphore(20)
_VOYAGE_SEMAPHORE          = asyncio.Semaphore(10)


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

    async with _GEMINI_GENERATE_SEMAPHORE:
        for attempt in range(3):
            try:
                response = await _gemini_client.aio.models.generate_content(
                    model=GEMINI_GENERATE_MODEL,
                    contents=prompt,
                )
                text = (response.text or "").strip()
                return text if text else _fallback_summary(chunk)
            except Exception as e:
                if attempt < 2:
                    wait = 2 ** attempt  # 1s, 2s, 4s
                    logger.warning("retry %d for %s: %s", attempt + 1, chunk["file_path"], e)
                    await asyncio.sleep(wait)
                else:
                    logger.warning("all retries failed for %s: %s", chunk["file_path"], e)
                    return _fallback_summary(chunk)


async def _embed_summary(summary: str) -> list[float] | None:
    async with _GEMINI_EMBED_SEMAPHORE:
        try:
            result = await asyncio.to_thread(
                _gemini_client.models.embed_content,
                model=GEMINI_EMBED_MODEL,
                contents=summary,
                config=types.EmbedContentConfig(
                    task_type="RETRIEVAL_DOCUMENT",
                    output_dimensionality=1536,   # add this line
                ),
            )
            return result.embeddings[0].values
        except Exception as e:
            logger.warning("summary embed failed: %s", e)
            return None


async def _embed_code(raw_code: str) -> list[float] | None:
    text = _truncate(raw_code, MAX_EMBED_INPUT_CHARS)
    async with _VOYAGE_SEMAPHORE:
        try:
            result = await _voyage_client.embed(
                texts=[text],
                model=VOYAGE_CODE_MODEL,
                input_type="document",
            )
            return result.embeddings[0]
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


async def process_chunks(chunks: list[dict], batch_size: int = 20) -> list[dict]:
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