"use client";

import { useEffect, useRef, useState } from "react";

// ── Steps derived from the real backend pipeline ──────────────────────────────
const STEPS = [
  { label: "Cloning repository",         detail: "Fetching source from GitHub"              },
  { label: "Walking & chunking files",   detail: "Splitting into function-level pieces"     },
  { label: "Summarizing & embedding",    detail: "Generating semantic summaries via LLM"    },
  { label: "Clustering & labeling",      detail: "Grouping files into domain submaps"       },
  { label: "Persisting to database",     detail: "Storing chunks, vectors & cluster tree"   },
];

// How long each step "holds" before auto-advancing (ms)
const STEP_DURATION = [8_000, 25_000, 60_000, 30_000, 8_000];
const TOTAL_FAKE_MS = STEP_DURATION.reduce((a, b) => a + b, 0);

interface Props {
  chunkCount: number; // live from polling
  repoName?: string;
}

export function IngestionProgress({ chunkCount, repoName }: Props) {
  const [elapsed, setElapsed]       = useState(0);
  const [stepIndex, setStepIndex]   = useState(0);
  const startRef                    = useRef(Date.now());
  const frameRef                    = useRef<number>(0);

  // Animate elapsed time with rAF
  useEffect(() => {
    const tick = () => {
      setElapsed(Date.now() - startRef.current);
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameRef.current);
  }, []);

  // Advance step index based on elapsed time
  useEffect(() => {
    let acc = 0;
    for (let i = 0; i < STEP_DURATION.length; i++) {
      acc += STEP_DURATION[i];
      if (elapsed < acc) {
        setStepIndex(i);
        break;
      }
    }
  }, [elapsed]);

  // Fake progress 0-95%, then chunk count nudges it toward 98%
  const fakeProgress  = Math.min((elapsed / TOTAL_FAKE_MS) * 95, 95);
  const chunkNudge    = chunkCount > 0 ? Math.min(chunkCount / 2000 * 3, 3) : 0; // tiny nudge
  const progress      = Math.min(fakeProgress + chunkNudge, 98);

  const elapsedSec    = Math.floor(elapsed / 1000);
  const elapsedLabel  = elapsedSec < 60
    ? `${elapsedSec}s`
    : `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#F3EEEA]">
      {/* Subtle dot grid background */}
      <div
        className="absolute inset-0 opacity-30"
        style={{
          backgroundImage: "radial-gradient(circle, #B0A695 1px, transparent 1px)",
          backgroundSize: "28px 28px",
        }}
      />

      <div className="relative w-full max-w-xl px-6">
        {/* Brand */}
        <div className="mb-10 text-center">
          <p className="text-[2rem] font-semibold tracking-[-0.07em] text-[#433b33]">
            ChizuCode
          </p>
          {repoName && (
            <p className="mt-1 font-mono text-sm text-[#776B5D]">{repoName}</p>
          )}
        </div>

        {/* Progress bar */}
        <div className="relative h-5 w-full overflow-hidden rounded-full border-[2px] border-[#B0A695] bg-[#EBE3D5] shadow-[4px_4px_0_#000]">
          <div
            className="h-full rounded-full bg-[#433b33] transition-all duration-700 ease-out"
            style={{ width: `${progress}%` }}
          />
          {/* Shimmer */}
          <div
            className="absolute inset-0 rounded-full"
            style={{
              background:
                "linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.18) 50%, transparent 100%)",
              animation: "shimmer 2s infinite",
            }}
          />
        </div>

        {/* Percent + elapsed */}
        <div className="mt-2 flex justify-between font-mono text-xs text-[#776B5D]">
          <span>{Math.round(progress)}%</span>
          <span>{elapsedLabel}</span>
        </div>

        {/* Steps list */}
        <ol className="mt-8 space-y-3">
          {STEPS.map((step, i) => {
            const done    = i < stepIndex;
            const active  = i === stepIndex;
            const pending = i > stepIndex;
            return (
              <li
                key={step.label}
                className={`flex items-start gap-3 transition-opacity duration-500 ${
                  pending ? "opacity-35" : "opacity-100"
                }`}
              >
                {/* Icon */}
                <span
                  className={`mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border-[2px] text-xs font-bold transition-all duration-300 ${
                    done
                      ? "border-[#433b33] bg-[#433b33] text-[#F3EEEA]"
                      : active
                      ? "border-[#433b33] bg-transparent text-[#433b33]"
                      : "border-[#B0A695] bg-transparent text-[#B0A695]"
                  }`}
                >
                  {done ? "✓" : i + 1}
                </span>

                {/* Text */}
                <div>
                  <p
                    className={`text-sm font-semibold leading-tight ${
                      done || active ? "text-[#433b33]" : "text-[#776B5D]"
                    }`}
                  >
                    {step.label}
                    {active && (
                      <span className="ml-2 inline-block animate-pulse text-[#776B5D]">
                        …
                      </span>
                    )}
                  </p>
                  {(done || active) && (
                    <p className="mt-0.5 font-mono text-xs text-[#776B5D]">
                      {step.detail}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>

        {/* Chunk count */}
        {chunkCount > 0 && (
          <p className="mt-8 text-center font-mono text-xs text-[#776B5D]">
            {chunkCount.toLocaleString()} chunks processed
          </p>
        )}
      </div>

      {/* Shimmer keyframe */}
      <style>{`
        @keyframes shimmer {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
      `}</style>
    </div>
  );
}
