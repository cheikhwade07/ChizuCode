"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, X } from 'lucide-react';
import { ChatInput } from './ChatInput';
import graphData from '@/test.json';
import workflowData from '@/workflow_test.json';

// --- Types ---
interface FileEntry { fileName: string; directory: string; functionality: string; connection: string[]; }
interface Submap { name: string; files: FileEntry[]; dependsOn?: string[]; }
interface GNode {
  id: string; type: 'submap' | 'file'; label: string;
  fileCount?: number; directory?: string; functionality?: string;
  isHighlighted?: boolean; isFaded?: boolean;
  x?: number; y?: number;
}
interface GLink { 
  source: string | GNode; target: string | GNode; 
  isAnimated?: boolean; isFaded?: boolean; isActiveEdge?: boolean;
  animStart?: number; animDur?: number; animForward?: boolean;
}

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
    ctx.font = 'bold 16px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(node.label.charAt(0).toUpperCase() + node.label.slice(1), x + 16, y + 74);

    // Bottom hint text
    ctx.font = '600 11px sans-serif'; ctx.fillStyle = '#444';
    ctx.fillText('Click to explore this domain >', x + 16, y + 96);
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
export function GraphViewerCanvas() {
  const submaps: Submap[] = (graphData as any).submaps;
  const [view, setView] = useState<string>('domain');
  const [isPlaying, setIsPlaying] = useState(false);
  const [popup, setPopup] = useState<{ node: GNode; sx: number; sy: number } | null>(null);
  const [dims, setDims] = useState({ w: 800, h: 600 });
  const nodesRef = useRef<GNode[]>([]);
  const linksRef = useRef<GLink[]>([]);
  const phaseRef = useRef(0);
  const graphRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const update = () => { if (containerRef.current) setDims({ w: containerRef.current.clientWidth, h: containerRef.current.clientHeight - 64 }); };
    update(); window.addEventListener('resize', update); return () => window.removeEventListener('resize', update);
  }, []);

  useEffect(() => {
    let raf: number;
    const tick = (ts: number) => { phaseRef.current = (ts / 600) * Math.PI; raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick); return () => cancelAnimationFrame(raf);
  }, []);

  const applyGraph = (nodes: GNode[], links: GLink[], isDomain: boolean = false) => {
    nodesRef.current = nodes; linksRef.current = links;
    graphRef.current?.d3ReheatSimulation();
    
    // Instantly zoom out when loading a new graph to avoid starting too zoomed in
    if (graphRef.current) {
      graphRef.current.zoom(0.8, 0);
    }

    // Space out nodes to form a web without cramping
    setTimeout(() => {
      if (graphRef.current) {
        // Domains are larger, so give them a massive repulsion to spread out widely
        graphRef.current.d3Force('charge').strength(isDomain ? -4000 : -1000);
        graphRef.current.d3Force('link').distance(isDomain ? 250 : 150);
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

  useEffect(() => { loadDomain(); }, [loadDomain]);

  const triggerAnimation = useCallback(() => {
    const workflow = (workflowData as any).flow;
    const path = workflow.paths[0]; 
    const dur = workflow.step_duration_ms || 1000;

    const activeIds = new Set(path);
    nodesRef.current.forEach(n => { n.isHighlighted = activeIds.has(n.id); n.isFaded = !activeIds.has(n.id); });
    
    linksRef.current.forEach(l => { l.isAnimated = false; l.isActiveEdge = false; l.isFaded = true; });
    setIsPlaying(true);
    
    let step = 0;
    
    const runStep = () => {
      if (step >= path.length - 1) {
        setTimeout(() => {
          nodesRef.current.forEach(n => { n.isHighlighted = false; n.isFaded = false; });
          linksRef.current.forEach(l => { l.isAnimated = false; l.isActiveEdge = false; l.isFaded = false; });
          setIsPlaying(false);
        }, 1000); // linger at the end
        return;
      }
      
      const srcNode = path[step];
      const tgtNode = path[step + 1];
      const activeKey = [srcNode, tgtNode].sort().join('|');
      
      linksRef.current.forEach(l => {
        const src = typeof l.source === 'string' ? l.source : (l.source as GNode).id;
        const tgt = typeof l.target === 'string' ? l.target : (l.target as GNode).id;
        const key = [src, tgt].sort().join('|');
        if (key === activeKey) {
          l.isAnimated = true;
          l.isActiveEdge = true; // persists the cyan color
          l.isFaded = false;
          l.animStart = performance.now();
          l.animDur = dur;
          l.animForward = (src === srcNode); 
        } else if (l.isAnimated) {
          l.isAnimated = false; // stop the particle, but leave isActiveEdge true
        }
      });
      
      step++;
      setTimeout(runStep, dur);
    };
    
    runStep();
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

  const handleEngineStop = useCallback(() => {
    if (graphRef.current) {
      graphRef.current.zoomToFit(400, 60);
      // Cap the zoom so it doesn't feel cramped if there are only a few nodes
      setTimeout(() => {
        if (graphRef.current && graphRef.current.zoom() > 1.0) {
          graphRef.current.zoom(1.0, 300);
        }
      }, 450);
    }
  }, []);

  return (
    <div ref={containerRef} className="w-full h-screen bg-[#e6d9c5] relative overflow-hidden">
      <div className="absolute top-0 left-0 right-0 z-20 flex items-center gap-3 px-5 py-4 bg-[#e8d7ae] border-b border-slate-800">
        <AnimatePresence>
          {view !== 'domain' && (
            <motion.button key="back" initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} onClick={loadDomain} className="flex items-center gap-1.5 text-black hover:text-blue-600 text-sm font-medium">
              <ArrowLeft className="h-4 w-4" /> All domains
            </motion.button>
          )}
        </AnimatePresence>
        <span className="text-black font-bold text-lg">Codebase Map</span>
        {view !== 'domain' && <><span className="text-slate-500">/</span><span className="text-blue-600 font-semibold capitalize">{view}</span></>}
        {isPlaying && <span className="ml-auto text-xs text-blue-600 animate-pulse font-semibold">Simulating login…</span>}
      </div>

      <div className="absolute inset-0 pt-16">
        <ForceGraph2D
          ref={graphRef}
          graphData={{ nodes: nodesRef.current, links: linksRef.current }}
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
          linkColor={(l: any) => l.isFaded ? '#47556944' : (l.isAnimated || l.isActiveEdge) ? '#06b6d4' : '#475569'}
          linkWidth={(l: any) => (l.isAnimated || l.isActiveEdge) ? 2.5 : 1.5}
          linkDirectionalParticles={(l: any) => l.isAnimated ? 1 : 0} // trigger render loop
          linkDirectionalParticleWidth={0} // hide default particle
          linkCanvasObjectMode={() => 'after'}
          linkCanvasObject={(l: any, ctx, scale) => {
            if (!l.isAnimated || !l.animStart) return;
            const start = l.animForward ? l.source : l.target;
            const end = l.animForward ? l.target : l.source;
            const t = performance.now() - l.animStart;
            const dur = l.animDur || 1000;
            const p1 = t / dur; // 0 to 1
            const p2 = p1 - 300 / dur; // trails behind
            
            const drawDot = (p: number, r: number, color: string, glow: boolean) => {
              if (p < 0 || p > 1) return;
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
      <ChatInput onSubmit={q => { if (q.toLowerCase().includes('login')) simulateLogin(); }} />
    </div>
  );
}
