"use client";

import dynamic from 'next/dynamic';

// react-force-graph-2d accesses `window` at import time — must be client-only
const GraphViewerCanvas = dynamic(
  () => import('./GraphViewerCanvas').then(m => ({ default: m.GraphViewerCanvas })),
  {
    ssr: false,
    loading: () => (
      <div className="w-full h-screen bg-[#e6d9c5] flex items-center justify-center">
        <span className="text-black/40 text-sm">Loading graph…</span>
      </div>
    ),
  }
);

export function GraphViewer({ repoId }: { repoId: string }) {
  return <GraphViewerCanvas repoId={repoId} />;
}
