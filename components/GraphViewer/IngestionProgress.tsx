"use client";

import { useEffect, useMemo, useRef, useState } from "react";

const LAYERS = [
  {
    title: "Repository",
    subtitle: "GitHub URL accepted and clone started",
    duration: 7000,
    items: ["clone", "scan", "filter"],
  },
  {
    title: "Code chunks",
    subtitle: "Files are split into readable pieces",
    duration: 22000,
    items: ["walk files", "split code", "normalize paths"],
  },
  {
    title: "LLM summaries",
    subtitle: "Each chunk gets a concise explanation",
    duration: 52000,
    items: ["summaries", "semantic vectors", "code vectors"],
  },
  {
    title: "Cluster map",
    subtitle: "Related files become labeled submaps",
    duration: 32000,
    items: ["group files", "label domains", "connect nodes"],
  },
  {
    title: "Postgres pgvector",
    subtitle: "Chunks, vectors, and the tree are persisted",
    duration: 12000,
    items: ["chunks", "vectors", "domains"],
  },
];

interface Props {
  chunkCount: number;
  repoName?: string;
}

function formatElapsed(ms: number) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function IngestionProgress({ chunkCount, repoName }: Props) {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(Date.now());

  const totalDuration = useMemo(
    () => LAYERS.reduce((sum, layer) => sum + layer.duration, 0),
    []
  );

  useEffect(() => {
    const interval = window.setInterval(() => {
      setElapsed(Date.now() - startRef.current);
    }, 200);

    return () => window.clearInterval(interval);
  }, []);

  const activeLayerIndex = useMemo(() => {
    let accumulated = 0;
    for (let i = 0; i < LAYERS.length; i += 1) {
      accumulated += LAYERS[i].duration;
      if (elapsed < accumulated) return i;
    }
    return LAYERS.length - 1;
  }, [elapsed]);

  const activeLayerElapsed = useMemo(
    () => LAYERS.slice(0, activeLayerIndex).reduce((sum, layer) => sum + layer.duration, 0),
    [activeLayerIndex]
  );

  const timeProgress = (elapsed / totalDuration) * 98;
  const chunkProgress = chunkCount > 0 ? Math.min(2 + chunkCount * 0.08, 12) : 0;
  const progress = Math.min(Math.max(timeProgress, chunkProgress), 98);
  const percent = progress.toFixed(1);
  const activeLayer = LAYERS[activeLayerIndex];

  return (
    <div className="fixed inset-0 z-[100] overflow-y-auto bg-[#F3EEEA] text-[#433b33]">
      <div
        className="fixed inset-0 opacity-25"
        style={{
          backgroundImage: "radial-gradient(circle, #B0A695 1px, transparent 1px)",
          backgroundSize: "28px 28px",
        }}
      />

      <div className="relative mx-auto flex min-h-screen w-full max-w-5xl flex-col justify-center px-5 py-8 sm:px-8">
        <header className="mb-7 text-center">
          <p className="text-5xl font-semibold leading-none tracking-[-0.06em] text-[#433b33] sm:text-6xl">
            ChizuCode
          </p>
          <p className="mt-4 text-sm uppercase tracking-[0.16em] text-[#776B5D]">
            Building your codebase map
          </p>
          {repoName && (
            <p className="mt-3 font-mono text-base text-[#776B5D]">{repoName}</p>
          )}
        </header>

        <section className="rounded-lg border-[2px] border-[#B0A695] bg-[#F8F3EC] p-5 shadow-[8px_8px_0_#000]">
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-[#776B5D]">Now processing</p>
              <p className="mt-1 text-2xl font-semibold text-[#433b33]">
                {activeLayer.title}
              </p>
            </div>
            <div className="text-right font-mono text-sm text-[#776B5D]">
              <p className="text-2xl font-semibold text-[#433b33]">{percent}%</p>
              <p>{formatElapsed(elapsed)}</p>
            </div>
          </div>

          <div className="mt-5 h-5 overflow-hidden rounded-full border-[2px] border-[#B0A695] bg-[#EBE3D5]">
            <div
              className="h-full origin-left rounded-full bg-[#776B5D] transition-transform duration-200 ease-linear"
              style={{ transform: `scaleX(${progress / 100})` }}
            />
          </div>

          {chunkCount > 0 && (
            <p className="mt-3 text-right font-mono text-xs text-[#776B5D]">
              {chunkCount.toLocaleString()} chunks processed
            </p>
          )}
        </section>

        <section className="mt-6 space-y-3">
          {LAYERS.map((layer, index) => {
            const done = index < activeLayerIndex;
            const active = index === activeLayerIndex;
            const visible = index <= activeLayerIndex;

            return (
              <div
                key={layer.title}
                className={`rounded-lg border-[2px] border-[#B0A695] bg-[#EBE3D5] p-4 transition-all duration-700 ${
                  visible ? "translate-y-0 opacity-100" : "translate-y-5 opacity-0"
                } ${active ? "shadow-[6px_6px_0_#776B5D]" : done ? "opacity-90" : ""}`}
              >
                <div className="grid gap-4 md:grid-cols-[180px_1fr] md:items-center">
                  <div>
                    <div className="flex items-center gap-3">
                      <span className="flex h-8 w-8 items-center justify-center rounded-full border-[2px] border-[#B0A695] bg-[#F3EEEA] font-mono text-sm text-[#433b33]">
                        {done ? "ok" : index + 1}
                      </span>
                      <p className="text-lg font-semibold text-[#433b33]">{layer.title}</p>
                    </div>
                    <p className="mt-2 text-sm leading-5 text-[#776B5D]">{layer.subtitle}</p>
                  </div>

                  <div className="grid gap-2 sm:grid-cols-3">
                    {layer.items.map((item, itemIndex) => {
                      const itemVisible =
                        done || (active && elapsed - activeLayerElapsed > itemIndex * (layer.duration / 4));
                      return (
                        <div
                          key={item}
                          className={`rounded-lg border border-[#B0A695] bg-[#F8F3EC] px-3 py-3 text-center text-sm font-medium text-[#776B5D] transition-all duration-700 ${
                            itemVisible ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0"
                          }`}
                        >
                          {item}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}
        </section>
      </div>
    </div>
  );
}
