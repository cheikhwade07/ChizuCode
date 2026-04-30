"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, X } from 'lucide-react';
import { forceCollide, forceX, forceY } from 'd3-force';
import { ChatPanel } from './ChatPanel';
import { fetchGraphData } from './adapter';

// --- Types ---
interface FileEntry { fileName: string; directory: string; functionality: string; connection: string[]; }
interface Submap { id?: string; name: string; files: FileEntry[]; dependsOn?: string[]; }
interface GraphData { rootId?: string; rootLabel: string; submaps: Submap[]; }
interface GNode {
  id: string; type: 'submap' | 'file'; label: string;
  fileCount?: number; directory?: string; functionality?: string;
  isHighlighted?: boolean; isFaded?: boolean;
  x?: number; y?: number; fx?: number; fy?: number;
}
interface GLink { source: string | GNode; target: string | GNode; isAnimated?: boolean; isFaded?: boolean; }

// --- Colors ---
const C = { bg: '#e6d9c5', nodeBg: '#e8d7ae', border: '#000000', text: '#000000', hlBorder: '#1d4ed8', hlGlow: '#60a5fa', edge: '#888888', edgeActive: '#1d4ed8' };

// --- Canvas helpers ---
function rrect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

// --- Icons ---
const FOLDER_PATHS = ["m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5c0-1.1.9-2 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2"];
const FILE_PATHS = ["M4 22h14a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v4", "M14 2v4a2 2 0 0 0 2 2h4", "m5 12-3 3 3 3", "m9 18 3-3-3-3"];

function drawIcon(ctx: CanvasRenderingContext2D, paths: string[], x: number, y: number, size: number, color: string) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 24, size / 24);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  paths.forEach(p => ctx.stroke(new Path2D(p)));
  ctx.restore();
}

function fitTextLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number
) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
      continue;
    }

    if (current) {
      lines.push(current);
      current = word;
    } else {
      current = word;
    }

    if (lines.length === maxLines) {
      break;
    }
  }

  if (lines.length < maxLines && current) {
    lines.push(current);
  }

  if (lines.length > maxLines) {
    lines.length = maxLines;
  }

  if (lines.length === 0) {
    return [''];
  }

  if (words.length > 0 && lines.length === maxLines) {
    let lastLine = lines[maxLines - 1];
    const usedWords = lines.join(' ').split(/\s+/).filter(Boolean).length;
    if (usedWords < words.length) {
      while (`${lastLine}…` && ctx.measureText(`${lastLine}…`).width > maxWidth && lastLine.length > 1) {
        lastLine = lastLine.slice(0, -1).trimEnd();
      }
      lines[maxLines - 1] = `${lastLine}…`;
    }
  }

  return lines;
}

function drawNode(node: GNode, ctx: CanvasRenderingContext2D, scale: number, phase: number) {
  const isSubmap = node.type === 'submap';
  const w = isSubmap ? 220 : 160;
  const h = isSubmap ? 120 : 48;
  const x = (node.x ?? 0) - w / 2;
  const y = (node.y ?? 0) - h / 2;
  const r = 12;
  ctx.globalAlpha = node.isFaded ? 0.3 : 1;

  if (node.isHighlighted) {
    const a = 0.3 + 0.3 * Math.sin(phase);
    ctx.save(); ctx.shadowColor = C.hlGlow; ctx.shadowBlur = 15 / scale;
    rrect(ctx, x - 4, y - 4, w + 8, h + 8, r + 4);
    ctx.fillStyle = C.hlGlow + Math.round(a * 255).toString(16).padStart(2, '0');
    ctx.fill(); ctx.restore();
  }

  // Hard shadow + Background
  ctx.save(); ctx.fillStyle = '#00000044'; rrect(ctx, x + 4 / scale, y + 4 / scale, w, h, r); ctx.fill(); ctx.restore();
  rrect(ctx, x, y, w, h, r); ctx.fillStyle = C.nodeBg; ctx.fill();
  ctx.strokeStyle = node.isHighlighted ? C.hlBorder : C.border; ctx.lineWidth = (node.isHighlighted ? 2 : 1) / scale; ctx.stroke();

  if (isSubmap) {
    // Top-left icon box
    ctx.fillStyle = '#e8d7ae'; rrect(ctx, x + 16, y + 16, 32, 32, 8); ctx.fill(); ctx.stroke();
    drawIcon(ctx, FOLDER_PATHS, x + 20, y + 20, 24, '#000');

    // Top-right file count badge
    ctx.fillStyle = '#e8d7ae'; rrect(ctx, x + w - 64, y + 20, 48, 24, 12); ctx.fill(); ctx.stroke();
    ctx.font = '600 10px sans-serif'; ctx.fillStyle = '#000'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(`${node.fileCount ?? 0} files`, x + w - 40, y + 32);

    // Main Submap Name
    const title = node.label.charAt(0).toUpperCase() + node.label.slice(1);
    ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'left'; ctx.fillStyle = C.text; ctx.textBaseline = 'top';
    const titleLines = fitTextLines(ctx, title, w - 32, 2);
    titleLines.forEach((line, index) => {
      ctx.fillText(line, x + 16, y + 66 + index * 18);
    });

    // Bottom hint text
    ctx.font = '600 11px sans-serif'; ctx.fillStyle = '#444'; ctx.textBaseline = 'alphabetic';
    ctx.fillText('Click to explore this domain >', x + 16, y + 104);
  } else {
    // File node icon
    ctx.fillStyle = node.isHighlighted ? '#dbeafe' : '#e8d7ae'; rrect(ctx, x + 10, y + 8, 32, 32, 8); ctx.fill(); ctx.stroke();
    drawIcon(ctx, FILE_PATHS, x + 14, y + 12, 24, node.isHighlighted ? C.hlBorder : '#000');
    
    // File Name
    ctx.font = '600 12px sans-serif'; ctx.fillStyle = node.isHighlighted ? C.hlBorder : C.text;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(node.label, x + 50, y + 24, w - 60);
  }
  ctx.globalAlpha = 1;
}

// --- Component ---
export function GraphViewerCanvas({ repoId }: { repoId: string }) {
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [graphState, setGraphState] = useState<{ nodes: GNode[]; links: GLink[] }>({ nodes: [], links: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<string>('domain');
  const [isPlaying, setIsPlaying] = useState(false);
  const [popup, setPopup] = useState<{ node: GNode; sx: number; sy: number } | null>(null);
  const [dims, setDims] = useState({ w: 800, h: 600 });
  const nodesRef = useRef<GNode[]>([]);
  const linksRef = useRef<GLink[]>([]);
  const phaseRef = useRef(0);
  const graphRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const submaps = graphData?.submaps ?? [];
  const isDomainView = view === 'domain';
  const currentSubmap = useMemo(
    () => (isDomainView ? null : submaps.find((submap) => submap.name === view) ?? null),
    [isDomainView, submaps, view]
  );
  const currentSubmapFileCount = useMemo(() => {
    if (isDomainView) return 0;
    return submaps.find((submap) => submap.name === view)?.files.length ?? 0;
  }, [isDomainView, submaps, view]);
  const currentScope = useMemo(() => {
    if (!graphData) {
      return { id: undefined, label: 'Root' };
    }

    if (isDomainView) {
      return { id: undefined, label: 'Root' };
    }

    if (!currentSubmap || currentSubmap.name === 'Project Root') {
      return { id: undefined, label: 'Root' };
    }

    return { id: currentSubmap.id, label: currentSubmap.name };
  }, [currentSubmap, graphData, isDomainView]);

  useEffect(() => {
    let cancelled = false;

    setLoading(true);
    setError(null);

    fetchGraphData(repoId)
      .then((data) => {
        if (cancelled) return;
        setGraphData(data);
        setLoading(false);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [repoId]);

  useEffect(() => {
    if (loading || error) return;
    const el = containerRef.current;
    if (!el) return;

    const update = () => {
      setDims({
        w: el.clientWidth,
        h: el.clientHeight - 64,
      });
    };

    update();
    const raf = requestAnimationFrame(update);
    const observer = new ResizeObserver(update);
    observer.observe(el);
    window.addEventListener('resize', update);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [loading, error]);

  useEffect(() => {
    let raf: number;
    const tick = (ts: number) => { phaseRef.current = (ts / 600) * Math.PI; raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick); return () => cancelAnimationFrame(raf);
  }, []);

  const applyGraph = (nodes: GNode[], links: GLink[], isDomain: boolean = false) => {
    nodesRef.current = nodes;
    linksRef.current = links;
    setGraphState({ nodes, links });
    graphRef.current?.d3ReheatSimulation();
    
    // Instantly zoom out when loading a new graph to avoid starting too zoomed in
    if (graphRef.current) {
      graphRef.current.zoom(0.8, 0);
    }

    // Keep the graph readable without letting a few strong repulsive forces fling nodes too far away.
    setTimeout(() => {
      if (graphRef.current) {
        graphRef.current.d3Force('charge').strength(isDomain ? -2200 : -440);
        graphRef.current.d3Force('link').distance(isDomain ? 165 : 94);
        graphRef.current.d3Force('collision', forceCollide(isDomain ? 112 : 76));
        graphRef.current.d3Force('x', forceX(0).strength(isDomain ? 0.04 : 0.13));
        graphRef.current.d3Force('y', forceY(0).strength(isDomain ? 0.04 : 0.13));
      }
    }, 10);
  };

  const loadDomain = useCallback(() => {
    setView('domain'); setIsPlaying(false); setPopup(null);
    const nodes = submaps.map((sm, i) => ({ 
      id: sm.name, 
      type: 'submap' as const, 
      label: sm.name, 
      fileCount: sm.files.length 
    }));
    const links: GLink[] = [];
    submaps.forEach(sm => sm.dependsOn?.forEach(t => links.push({ source: sm.name, target: t })));
    applyGraph(nodes, links, true);
  }, [submaps]);

  const loadSubmap = useCallback((name: string) => {
    const sm = submaps.find(s => s.name === name);
    if (!sm) return;
    setView(name); setIsPlaying(false); setPopup(null);
    const names = new Set(sm.files.map(f => f.fileName));
    const nodes = sm.files.map(f => ({ id: f.fileName, type: 'file' as const, label: f.fileName, directory: f.directory, functionality: f.functionality }));
    const seen = new Set<string>();
    const links: GLink[] = [];
    for (const f of sm.files) {
      for (const c of f.connection) {
        if (!names.has(c)) continue;
        const key = [f.fileName, c].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key); links.push({ source: f.fileName, target: c });
      }
    }
    applyGraph(nodes, links, false);
  }, [submaps]);

  useEffect(() => {
    if (!graphData) return;
    loadDomain();
  }, [graphData, loadDomain]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isDomainView) {
        setPopup(null);
        loadDomain();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isDomainView, loadDomain]);

  const triggerAnimation = useCallback(() => {
    const activeIds = new Set(['userService.js', 'authController.js']);
    nodesRef.current.forEach(n => { n.isHighlighted = activeIds.has(n.id); n.isFaded = !activeIds.has(n.id); });
    linksRef.current.forEach(l => {
      const src = typeof l.source === 'string' ? l.source : (l.source as GNode).id;
      const tgt = typeof l.target === 'string' ? l.target : (l.target as GNode).id;
      const active = [src, tgt].sort().join('|') === ['userService.js', 'authController.js'].sort().join('|');
      l.isAnimated = active; l.isFaded = !active;
    });
    setGraphState(({ nodes, links }) => ({ nodes: [...nodes], links: [...links] }));
    setIsPlaying(true);
    setTimeout(() => {
      nodesRef.current.forEach(n => { n.isHighlighted = false; n.isFaded = false; });
      linksRef.current.forEach(l => { l.isAnimated = false; l.isFaded = false; });
      setGraphState(({ nodes, links }) => ({ nodes: [...nodes], links: [...links] }));
      setIsPlaying(false);
    }, 6000);
  }, []);

  const simulateLogin = useCallback(() => {
    if (view !== 'login') { loadSubmap('login'); setTimeout(triggerAnimation, 800); }
    else triggerAnimation();
  }, [view, loadSubmap, triggerAnimation]);

  const handleNodeClick = useCallback((node: any) => {
    const n = node as GNode;
    if (n.type === 'submap') loadSubmap(n.label);
    else if (graphRef.current) {
      const { x, y } = graphRef.current.graph2ScreenCoords(n.x ?? 0, n.y ?? 0);
      setPopup(prev => prev?.node.id === n.id ? null : { node: n, sx: x, sy: y });
    }
  }, [loadSubmap]);

  const handleNodeDragEnd = useCallback((node: any) => {
    const draggedNode = node as GNode;
    draggedNode.fx = draggedNode.x;
    draggedNode.fy = draggedNode.y;
    setGraphState(({ nodes, links }) => ({ nodes: [...nodes], links: [...links] }));
  }, []);

  const handleEngineStop = useCallback(() => {
    if (graphRef.current) {
      const isDomain = view === 'domain';
      graphRef.current.centerAt(0, 0, 250);
      graphRef.current.zoomToFit(400, isDomain ? 72 : 78);
      // Cap the zoom so it doesn't feel cramped if there are only a few nodes
      setTimeout(() => {
        if (graphRef.current) {
          const currentZoom = graphRef.current.zoom();
          const maxZoom = isDomain ? 1.02 : 1.08;
          const minZoom = isDomain ? 0.74 : 0.88;

          if (currentZoom > maxZoom) {
            graphRef.current.zoom(maxZoom, 300);
          } else if (currentZoom < minZoom) {
            graphRef.current.zoom(minZoom, 300);
          }
        }
      }, 450);
    }
  }, [view]);

  if (loading) {
    return (
      <div className="w-full h-screen bg-[#e6d9c5] flex items-center justify-center">
        <span className="text-black/40 text-sm">Loading graph…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="w-full h-screen bg-[#e6d9c5] flex items-center justify-center px-6">
        <span className="text-red-700 text-sm">Graph error: {error}</span>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="w-full h-screen bg-[#e6d9c5] relative overflow-hidden">
      <div className="absolute top-0 left-0 right-0 z-20 flex items-center gap-3 px-5 py-4 bg-[#e8d7ae] border-b border-slate-800">
        <AnimatePresence>
          {!isDomainView && (
            <motion.button key="back" initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} onClick={loadDomain} className="flex items-center gap-1.5 text-black hover:text-blue-600 text-sm font-medium">
              <ArrowLeft className="h-4 w-4" /> All domains
            </motion.button>
          )}
        </AnimatePresence>
        <span className="text-black font-bold text-lg">Codebase Map</span>
        {!isDomainView && <><span className="text-slate-500">/</span><span className="text-blue-600 font-semibold capitalize">{view}</span></>}
        {isPlaying && <span className="ml-auto text-xs text-blue-600 animate-pulse font-semibold">Simulating login…</span>}
      </div>

      <div className="absolute inset-0 pt-16">
        <AnimatePresence>
          {!isDomainView && (
            <motion.button
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 12 }}
              onClick={loadDomain}
              className="absolute left-5 top-20 z-20 flex items-center gap-2 rounded-full border border-black bg-[#f4ead4] px-4 py-2 text-sm font-medium text-black shadow-[3px_3px_0px_0px_rgba(0,0,0,0.8)] transition hover:-translate-y-0.5 hover:text-blue-600"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to domains
              <span className="text-xs text-slate-500">{currentSubmapFileCount} files</span>
            </motion.button>
          )}
        </AnimatePresence>
        <ForceGraph2D
          ref={graphRef}
          graphData={graphState}
          width={dims.w} height={dims.h}
          backgroundColor={C.bg}
          nodeCanvasObject={(node, ctx, scale) => drawNode(node as GNode, ctx, scale, phaseRef.current)}
          nodeCanvasObjectMode={() => 'replace'}
          nodeVal={(n: any) => (n.type === 'submap' ? 70 : 35)}
          nodePointerAreaPaint={(n: any, color, ctx) => {
            const w = n.type === 'submap' ? 220 : 160;
            const h = n.type === 'submap' ? 120 : 48;
            ctx.fillStyle = color; ctx.fillRect((n.x ?? 0) - w / 2, (n.y ?? 0) - h / 2, w, h);
          }}
          onNodeClick={handleNodeClick}
          onNodeDragEnd={handleNodeDragEnd}
          linkColor={(l: any) => l.isFaded ? '#64748b33' : l.isAnimated ? '#0f766e' : '#334155aa'}
          linkWidth={(l: any) => l.isAnimated ? 2.4 : isDomainView ? 1.35 : 1.15}
          linkCurvature={isDomainView ? 0.05 : 0.1}
          linkDirectionalParticles={(l: any) => l.isAnimated ? 1 : 0} // trigger render loop
          linkDirectionalParticleWidth={0} // hide default particle
          linkCanvasObjectMode={() => 'after'}
          linkCanvasObject={(l: any, ctx, scale) => {
            if (!l.isAnimated) return;
            const start = l.source;
            const end = l.target;
            const p1 = (performance.now() % 1600) / 1600;
            const p2 = (p1 - 300 / 1600 + 1) % 1;
            
            const drawDot = (p: number, r: number, color: string, glow: boolean) => {
              const x = start.x + (end.x - start.x) * p;
              const y = start.y + (end.y - start.y) * p;
              ctx.beginPath();
              ctx.arc(x, y, r / scale, 0, 2 * Math.PI, false);
              ctx.fillStyle = color;
              if (glow) {
                ctx.shadowColor = color;
                ctx.shadowBlur = 6 / scale;
              } else {
                ctx.shadowBlur = 0;
              }
              ctx.fill();
            };

            ctx.save();
            drawDot(p1, 5, '#22d3ee', true);
            drawDot(p2, 3, '#67e8f9', false);
            ctx.restore();
          }}
          warmupTicks={100}
          onEngineStop={handleEngineStop}
        />
      </div>

      <AnimatePresence>
        {popup && (
          <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }}
            className="absolute z-30 w-72 rounded-xl border border-black bg-[#E8DFCA] shadow-xl p-4"
            style={{ left: popup.sx + 16, top: popup.sy - 40 }} onMouseDown={e => e.stopPropagation()}>
            <button className="absolute top-2 right-2 text-slate-500 hover:text-black" onClick={() => setPopup(null)}><X className="h-4 w-4" /></button>
            <p className="text-xs font-bold text-blue-600 uppercase mb-1">Directory</p>
            <p className="text-sm font-mono text-black mb-3 break-all">{popup.node.directory}</p>
            <p className="text-xs font-bold text-blue-600 uppercase mb-1">Functionality</p>
            <p className="text-sm text-black leading-relaxed">{popup.node.functionality}</p>
          </motion.div>
        )}
      </AnimatePresence>
      <ChatPanel
        repoId={repoId}
        scope={currentScope}
        onQuerySubmitted={(query) => {
          if (query.toLowerCase().includes('login')) {
            simulateLogin();
          }
        }}
      />
    </div>
  );
}
