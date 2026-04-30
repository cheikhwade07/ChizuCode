"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, X } from 'lucide-react';
import { forceCollide, forceX, forceY } from 'd3-force';
import { ChatPanel } from './ChatPanel';
import { fetchGraphData, type BackendNode, type WorkflowFlow } from './adapter';
import workflowData from '@/workflow_test.json'; // YOUR: workflow animation data

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// TEAMMATE: FileEntry/Submap/GraphData include id fields for RAG scoping
interface FileEntry { fileName: string; directory: string; functionality: string; connection: string[]; leafNodes?: BackendNode[]; }
interface Submap { id?: string; name: string; files: FileEntry[]; dependsOn?: string[]; }
interface GraphData { rootId?: string; rootLabel: string; submaps: Submap[]; }
type WorkflowAnimationPayload = { flow: WorkflowFlow };
interface InternalNodePos {
    id: string;
    label: string;
    responsibility: string;
    x: number;
    y: number;
}
interface InternalParticle {
    from: string;
    to: string;
    startedAt: number;
    dur: number;
}

interface GNode {
    id: string; type: 'submap' | 'file'; label: string;
    fileCount?: number; directory?: string; functionality?: string;
    isHighlighted?: boolean; isFaded?: boolean;
    x?: number; y?: number; fx?: number; fy?: number; vx?: number; vy?: number;
}

// YOUR: GLink has workflow animation fields (animForward, animStart, animDur, isActiveEdge)
// TEAMMATE: GLink has isAnimated, isFaded
// MERGED: all fields present
interface GLink {
    source: string | GNode; target: string | GNode;
    isAnimated?: boolean; isFaded?: boolean; isActiveEdge?: boolean;
    animStart?: number; animDur?: number; animForward?: boolean;
}

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

const C = {
    bg: '#F3EEEA',
    nodeBg: '#EBE3D5',
    control: '#DDD4C7',
    border: '#B0A695',
    text: '#433b33',
    muted: '#776B5D',
    accent: '#2F5D8C',
    accentSoft: '#D7E3EA',
    hlBorder: '#2F5D8C',
    hlGlow: '#D7E3EA',
    edge: '#8f8377',
    edgeActive: '#2F5D8C',
};

// ---------------------------------------------------------------------------
// Canvas helpers
// ---------------------------------------------------------------------------

function rrect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

const FOLDER_PATHS = ["m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5c0-1.1.9-2 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2"];
const FILE_PATHS = ["M4 22h14a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v4", "M14 2v4a2 2 0 0 0 2 2h4", "m5 12-3 3 3 3", "m9 18 3-3-3-3"];

function drawIcon(ctx: CanvasRenderingContext2D, paths: string[], x: number, y: number, size: number, color: string) {
    ctx.save();
    ctx.translate(x, y); ctx.scale(size / 24, size / 24);
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    paths.forEach(p => ctx.stroke(new Path2D(p)));
    ctx.restore();
}

// ---------------------------------------------------------------------------
// TEAMMATE: fitTextLines — proper multi-line text wrapping for submap labels
// ---------------------------------------------------------------------------

function fitTextLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number) {
    const words = text.trim().split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let current = '';

    for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;
        if (ctx.measureText(candidate).width <= maxWidth) { current = candidate; continue; }
        if (current) { lines.push(current); current = word; }
        else { current = word; }
        if (lines.length === maxLines) break;
    }

    if (lines.length < maxLines && current) lines.push(current);
    if (lines.length > maxLines) lines.length = maxLines;
    if (lines.length === 0) return [''];

    if (words.length > 0 && lines.length === maxLines) {
        let lastLine = lines[maxLines - 1];
        const usedWords = lines.join(' ').split(/\s+/).filter(Boolean).length;
        if (usedWords < words.length) {
            while (ctx.measureText(`${lastLine}…`).width > maxWidth && lastLine.length > 1) {
                lastLine = lastLine.slice(0, -1).trimEnd();
            }
            lines[maxLines - 1] = `${lastLine}…`;
        }
    }
    return lines;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function computeInternalPositions(node: GNode, steps: string[], leafNodes: BackendNode[]): Record<string, InternalNodePos> {
    const uniqueSteps = [...new Set(steps)];
    const cardHeight = Math.min(300, 76 + Math.min(uniqueSteps.length, 6) * 38 + (uniqueSteps.length > 6 ? 24 : 0));
    const positions: Record<string, InternalNodePos> = {};

    uniqueSteps.forEach((id, i) => {
        const leafNode = leafNodes.find(n => n.id === id || n.label === id);
        positions[id] = {
            id,
            label: leafNode?.label ?? id,
            responsibility: leafNode?.responsibility ?? '',
            x: node.x ?? 0,
            y: (node.y ?? 0) - cardHeight / 2 + 87 + i * 38,
        };
    });

    return positions;
}

function drawExpandedNode(
    node: GNode,
    ctx: CanvasRenderingContext2D,
    scale: number,
    phase: number,
    internalNodes: Record<string, InternalNodePos>,
    activeInternalIds: Set<string>,
    internalParticle: InternalParticle | null
) {
    const internals = Object.values(internalNodes);
    const visibleInternals = internals.slice(0, 6);
    const hiddenCount = Math.max(0, internals.length - visibleInternals.length);
    const w = 280;
    const h = Math.min(300, 76 + visibleInternals.length * 38 + (hiddenCount > 0 ? 24 : 0));
    const x = (node.x ?? 0) - w / 2;
    const y = (node.y ?? 0) - h / 2;
    const r = 14;

    ctx.globalAlpha = node.isFaded ? 0.35 : 1;

    const glow = 0.25 + 0.25 * Math.sin(phase);
    ctx.save();
    ctx.shadowColor = C.hlGlow;
    ctx.shadowBlur = 18 / scale;
    rrect(ctx, x - 5, y - 5, w + 10, h + 10, r + 5);
    ctx.fillStyle = C.hlGlow + Math.round(glow * 255).toString(16).padStart(2, '0');
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.fillStyle = '#00000033';
    rrect(ctx, x + 5 / scale, y + 5 / scale, w, h, r);
    ctx.fill();
    ctx.restore();

    rrect(ctx, x, y, w, h, r);
    ctx.fillStyle = C.nodeBg;
    ctx.fill();
    ctx.strokeStyle = C.hlBorder;
    ctx.lineWidth = 2 / scale;
    ctx.stroke();

    ctx.font = '700 14px sans-serif';
    ctx.fillStyle = C.text;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    fitTextLines(ctx, node.label, w - 32, 2).forEach((line, i) => {
        ctx.fillText(line, x + 16, y + 14 + i * 17);
    });

    ctx.font = '600 9px sans-serif';
    ctx.fillStyle = C.muted;
    ctx.fillText('Internal components', x + 16, y + 52, w - 32);

    visibleInternals.forEach((internal, i) => {
        const rowY = y + 72 + i * 38;
        const active = activeInternalIds.has(internal.id);
        ctx.fillStyle = active ? C.accentSoft : '#F3EEEA';
        rrect(ctx, x + 12, rowY, w - 24, 30, 8);
        ctx.fill();
        ctx.strokeStyle = active ? C.accent : C.border;
        ctx.lineWidth = (active ? 1.5 : 1) / scale;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(x + 28, rowY + 15, active ? 5 : 4, 0, Math.PI * 2);
        ctx.fillStyle = active ? C.accent : C.muted;
        ctx.fill();

        ctx.font = active ? '700 11px sans-serif' : '600 11px sans-serif';
        ctx.fillStyle = active ? C.accent : C.text;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(internal.label, x + 42, rowY + 15, w - 58);
    });

    if (hiddenCount > 0) {
        ctx.font = '600 10px sans-serif';
        ctx.fillStyle = C.muted;
        ctx.fillText(`+${hiddenCount} more`, x + 16, y + h - 22);
    }

    if (internalParticle) {
        const from = internalNodes[internalParticle.from];
        const to = internalNodes[internalParticle.to];
        if (from && to) {
            const progress = Math.min(1, Math.max(0, (performance.now() - internalParticle.startedAt) / internalParticle.dur));
            const px = from.x + (to.x - from.x) * progress;
            const py = from.y + (to.y - from.y) * progress;

            ctx.save();
            ctx.strokeStyle = C.accent;
            ctx.lineWidth = 1.4 / scale;
            ctx.setLineDash([4 / scale, 4 / scale]);
            ctx.beginPath();
            ctx.moveTo(from.x, from.y);
            ctx.lineTo(to.x, to.y);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.beginPath();
            ctx.arc(px, py, 5 / scale, 0, Math.PI * 2);
            ctx.fillStyle = C.accent;
            ctx.shadowColor = C.accentSoft;
            ctx.shadowBlur = 8 / scale;
            ctx.fill();
            ctx.restore();
        }
    }

    ctx.globalAlpha = 1;
}


// ---------------------------------------------------------------------------
// drawNode — TEAMMATE base + YOUR highlight animation (phase-based glow)
// ---------------------------------------------------------------------------

function drawNode(
    node: GNode,
    ctx: CanvasRenderingContext2D,
    scale: number,
    phase: number,
    expandedNodeId: string | null,
    internalNodes: Record<string, InternalNodePos>,
    activeInternalIds: Set<string>,
    internalParticle: InternalParticle | null
) {
    if (node.type === 'file' && node.id === expandedNodeId) {
        drawExpandedNode(node, ctx, scale, phase, internalNodes, activeInternalIds, internalParticle);
        return;
    }

    const isSubmap = node.type === 'submap';
    const w = isSubmap ? 220 : 160;
    const h = isSubmap ? 120 : 48;
    const x = (node.x ?? 0) - w / 2;
    const y = (node.y ?? 0) - h / 2;
    const r = 12;
    ctx.globalAlpha = node.isFaded ? 0.3 : 1;

    // Highlight glow (phase-animated)
    if (node.isHighlighted) {
        const a = 0.3 + 0.3 * Math.sin(phase);
        ctx.save(); ctx.shadowColor = C.hlGlow; ctx.shadowBlur = 15 / scale;
        rrect(ctx, x - 4, y - 4, w + 8, h + 8, r + 4);
        ctx.fillStyle = C.hlGlow + Math.round(a * 255).toString(16).padStart(2, '0');
        ctx.fill(); ctx.restore();
    }

    // Shadow + background
    ctx.save(); ctx.fillStyle = '#00000033'; rrect(ctx, x + 4 / scale, y + 4 / scale, w, h, r); ctx.fill(); ctx.restore();
    rrect(ctx, x, y, w, h, r); ctx.fillStyle = C.nodeBg; ctx.fill();
    ctx.strokeStyle = node.isHighlighted ? C.hlBorder : C.border;
    ctx.lineWidth = (node.isHighlighted ? 2 : 1) / scale; ctx.stroke();

    if (isSubmap) {
        // Icon box
        ctx.fillStyle = C.control; rrect(ctx, x + 16, y + 16, 32, 32, 8); ctx.fill(); ctx.stroke();
        drawIcon(ctx, FOLDER_PATHS, x + 20, y + 20, 24, C.text);

        // File count badge
        ctx.fillStyle = C.control; rrect(ctx, x + w - 64, y + 20, 48, 24, 12); ctx.fill(); ctx.stroke();
        ctx.font = '600 10px sans-serif'; ctx.fillStyle = C.text; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(`${node.fileCount ?? 0} files`, x + w - 40, y + 32);

        // TEAMMATE: fitTextLines for label
        const title = node.label.charAt(0).toUpperCase() + node.label.slice(1);
        ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'left'; ctx.fillStyle = C.text; ctx.textBaseline = 'top';
        const titleLines = fitTextLines(ctx, title, w - 32, 2);
        titleLines.forEach((line, i) => ctx.fillText(line, x + 16, y + 66 + i * 18));

        ctx.font = '600 11px sans-serif'; ctx.fillStyle = C.muted; ctx.textBaseline = 'alphabetic';
        ctx.fillText('Click to explore this domain >', x + 16, y + 104);
    } else {
        // File node
        ctx.fillStyle = node.isHighlighted ? C.control : C.nodeBg;
        rrect(ctx, x + 10, y + 8, 32, 32, 8); ctx.fill(); ctx.stroke();
        drawIcon(ctx, FILE_PATHS, x + 14, y + 12, 24, node.isHighlighted ? C.hlBorder : C.text);
        ctx.font = '600 12px sans-serif'; ctx.fillStyle = node.isHighlighted ? C.hlBorder : C.text;
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(node.label, x + 50, y + 24, w - 60);
    }
    ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function GraphViewerCanvas({ repoId }: { repoId: string }) {
    // TEAMMATE: live data from backend
    const [graphData, setGraphData] = useState<GraphData | null>(null);
    const [graphState, setGraphState] = useState<{ nodes: GNode[]; links: GLink[] }>({ nodes: [], links: [] });
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const [view, setView] = useState<string>('domain');
    const [isPlaying, setIsPlaying] = useState(false);
    const [expandedNodeId, setExpandedNodeId] = useState<string | null>(null);
    const [internalNodes, setInternalNodes] = useState<Record<string, InternalNodePos>>({});
    const [activeInternalIds, setActiveInternalIds] = useState<Set<string>>(new Set());
    const [internalParticle, setInternalParticle] = useState<InternalParticle | null>(null);
    const [popup, setPopup] = useState<{ node: GNode; sx: number; sy: number } | null>(null);
    const [dims, setDims] = useState({ w: 800, h: 600 });

    const nodesRef = useRef<GNode[]>([]);
    const linksRef = useRef<GLink[]>([]);
    const phaseRef = useRef(0);
    const graphRef = useRef<any>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const isPlayingRef = useRef(false);
    const isMountedRef = useRef(true);
    const currentAnimationRef = useRef<symbol | null>(null);
    const engineStopResolverRef = useRef<(() => void) | null>(null);
    const expandedNodeIdRef = useRef<string | null>(null);
    const internalNodesRef = useRef<Record<string, InternalNodePos>>({});
    const activeInternalIdsRef = useRef<Set<string>>(new Set());
    const internalParticleRef = useRef<InternalParticle | null>(null);

    const submaps = graphData?.submaps ?? [];
    const isDomainView = view === 'domain';

    const currentSubmap = useMemo(
        () => (isDomainView ? null : submaps.find(s => s.name === view) ?? null),
        [isDomainView, submaps, view]
    );

    const currentSubmapFileCount = useMemo(
        () => isDomainView ? 0 : (submaps.find(s => s.name === view)?.files.length ?? 0),
        [isDomainView, submaps, view]
    );

    // TEAMMATE: currentScope drives RAG domain_id for ChatPanel
    const currentScope = useMemo(() => {
        if (!graphData || isDomainView) return { id: undefined, label: 'Root' };
        if (!currentSubmap || currentSubmap.name === 'Project Root') return { id: undefined, label: 'Root' };
        return { id: currentSubmap.id, label: currentSubmap.name };
    }, [currentSubmap, graphData, isDomainView]);

    const forceCanvasRender = useCallback(() => {
        setGraphState(({ nodes, links }) => ({ nodes: [...nodes], links: [...links] }));
    }, []);

    useEffect(() => { expandedNodeIdRef.current = expandedNodeId; }, [expandedNodeId]);
    useEffect(() => { internalNodesRef.current = internalNodes; }, [internalNodes]);
    useEffect(() => { activeInternalIdsRef.current = activeInternalIds; }, [activeInternalIds]);
    useEffect(() => { internalParticleRef.current = internalParticle; }, [internalParticle]);

    const waitForEngineStop = useCallback((timeoutMs = 1400) => (
        new Promise<void>(resolve => {
            const resolver = () => {
                window.clearTimeout(timeoutId);
                resolve();
            };
            const timeoutId = window.setTimeout(() => {
                if (engineStopResolverRef.current === resolver) {
                    engineStopResolverRef.current = null;
                }
                resolve();
            }, timeoutMs);

            engineStopResolverRef.current = resolver;
        })
    ), []);

    const updateExpandedNodeId = useCallback((value: string | null) => {
        expandedNodeIdRef.current = value;
        setExpandedNodeId(value);
    }, []);

    const updateInternalNodes = useCallback((value: Record<string, InternalNodePos>) => {
        internalNodesRef.current = value;
        setInternalNodes(value);
    }, []);

    const updateActiveInternalIds = useCallback((value: Set<string>) => {
        activeInternalIdsRef.current = value;
        setActiveInternalIds(value);
    }, []);

    const updateInternalParticle = useCallback((value: InternalParticle | null) => {
        internalParticleRef.current = value;
        setInternalParticle(value);
    }, []);

    const pinCurrentNodes = useCallback(() => {
        nodesRef.current.forEach(n => {
            n.fx = n.x ?? 0;
            n.fy = n.y ?? 0;
            n.vx = 0;
            n.vy = 0;
        });
        graphRef.current?.d3AlphaTarget?.(0);
        forceCanvasRender();
    }, [forceCanvasRender]);

    const unpinCurrentNodes = useCallback(() => {
        nodesRef.current.forEach(n => {
            n.fx = undefined;
            n.fy = undefined;
            n.vx = 0;
            n.vy = 0;
        });
    }, []);

    const focusNodes = useCallback((nodeIds: string[], zoom = 1.12, duration = 650) => {
        if (!graphRef.current || nodeIds.length === 0) return;

        const selected = nodesRef.current.filter(n => nodeIds.includes(n.id));
        if (selected.length === 0) return;

        const centerX = selected.reduce((sum, node) => sum + (node.x ?? 0), 0) / selected.length;
        const centerY = selected.reduce((sum, node) => sum + (node.y ?? 0), 0) / selected.length;

        graphRef.current.centerAt(centerX, centerY, duration);
        graphRef.current.zoom(zoom, duration);
    }, []);

    // ---------------------------------------------------------------------------
    // Data fetch — TEAMMATE (live API, cancelled flag)
    // ---------------------------------------------------------------------------

    useEffect(() => {
        let cancelled = false;
        setLoading(true); setError(null);
        fetchGraphData(repoId)
            .then(data => { if (!cancelled) { setGraphData(data); setLoading(false); } })
            .catch((err: Error) => { if (!cancelled) { setError(err.message); setLoading(false); } });
        return () => { cancelled = true; };
    }, [repoId]);

    // ---------------------------------------------------------------------------
    // Resize observer — TEAMMATE
    // ---------------------------------------------------------------------------

    useEffect(() => {
        if (loading || error) return;
        const el = containerRef.current;
        if (!el) return;
        const update = () => setDims({ w: el.clientWidth, h: el.clientHeight - 64 });
        update();
        const raf = requestAnimationFrame(update);
        const observer = new ResizeObserver(update);
        observer.observe(el);
        window.addEventListener('resize', update);
        return () => { cancelAnimationFrame(raf); observer.disconnect(); window.removeEventListener('resize', update); };
    }, [loading, error]);

    // Mount/unmount tracking
    useEffect(() => {
        isMountedRef.current = true;
        return () => {
            isMountedRef.current = false;
            currentAnimationRef.current = null;
            isPlayingRef.current = false;
            engineStopResolverRef.current = null;
        };
    }, []);

    // Phase loop for highlight glow
    useEffect(() => {
        let raf: number;
        const tick = (ts: number) => { phaseRef.current = (ts / 600) * Math.PI; raf = requestAnimationFrame(tick); };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, []);

    useEffect(() => {
        if (!isPlaying && !expandedNodeId) return;
        let raf: number;
        const tick = () => {
            forceCanvasRender();
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [expandedNodeId, forceCanvasRender, isPlaying]);

    // ---------------------------------------------------------------------------
    // applyGraph — TEAMMATE forces (collision, x, y) + YOUR charge/distance values
    // ---------------------------------------------------------------------------

    const applyGraph = (nodes: GNode[], links: GLink[], isDomain: boolean = false) => {
        nodesRef.current = nodes;
        linksRef.current = links;
        setGraphState({ nodes, links });
        graphRef.current?.d3ReheatSimulation();
        if (graphRef.current) graphRef.current.zoom(0.8, 0);

        setTimeout(() => {
            if (!graphRef.current) return;
            // YOUR: stronger charge/distance values for better spacing
            graphRef.current.d3Force('charge').strength(isDomain ? -2200 : -440);
            graphRef.current.d3Force('link').distance(isDomain ? 165 : 94);
            // TEAMMATE: collision + centering forces
            graphRef.current.d3Force('collision', forceCollide(isDomain ? 112 : 76));
            graphRef.current.d3Force('x', forceX(0).strength(isDomain ? 0.04 : 0.13));
            graphRef.current.d3Force('y', forceY(0).strength(isDomain ? 0.04 : 0.13));
        }, 10);
    };

    // ---------------------------------------------------------------------------
    // Navigation
    // ---------------------------------------------------------------------------

    const loadDomain = useCallback((preservePlayback = false) => {
        setView('domain');
        if (!preservePlayback) setIsPlaying(false);
        setPopup(null);
        updateExpandedNodeId(null);
        updateInternalNodes({});
        updateActiveInternalIds(new Set());
        updateInternalParticle(null);
        const nodes = submaps.map(sm => ({
            id: sm.name, type: 'submap' as const, label: sm.name, fileCount: sm.files.length
        }));
        const links: GLink[] = [];
        submaps.forEach(sm => sm.dependsOn?.forEach(t => links.push({ source: sm.name, target: t })));
        applyGraph(nodes, links, true);
    }, [submaps, updateActiveInternalIds, updateExpandedNodeId, updateInternalNodes, updateInternalParticle]);

    const loadSubmap = useCallback((name: string, preservePlayback = false) => {
        const sm = submaps.find(s => s.name === name);
        if (!sm) return;
        setView(name);
        if (!preservePlayback) setIsPlaying(false);
        setPopup(null);
        updateExpandedNodeId(null);
        updateInternalNodes({});
        updateActiveInternalIds(new Set());
        updateInternalParticle(null);
        const names = new Set(sm.files.map(f => f.fileName));
        const nodes = sm.files.map(f => ({
            id: f.fileName, type: 'file' as const,
            label: f.fileName, directory: f.directory, functionality: f.functionality
        }));
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
    }, [submaps, updateActiveInternalIds, updateExpandedNodeId, updateInternalNodes, updateInternalParticle]);

    useEffect(() => { if (graphData) loadDomain(); }, [graphData, loadDomain]);

    // TEAMMATE: Escape key exits submap view
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (isPlayingRef.current) return;
            if (e.key === 'Escape' && !isDomainView) { setPopup(null); loadDomain(); }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [isDomainView, loadDomain]);

    // ---------------------------------------------------------------------------
    // YOUR: Workflow animation — reads workflowData.flow.paths[0]
    // Keeps isActiveEdge (cyan edge persists after particle), animForward (correct direction)
    // ---------------------------------------------------------------------------

    const triggerAnimation = useCallback(async (workflowOverride?: WorkflowAnimationPayload) => {
        if (isPlayingRef.current) return;

        const fallbackWorkflow = workflowData as WorkflowAnimationPayload;
        const flow = (workflowOverride ?? fallbackWorkflow).flow;
        const animationId = Symbol('workflow-animation');
        const dur = Math.max(typeof flow.step_duration_ms === 'number' ? flow.step_duration_ms : 1000, 400);
        const tempLinkKeys = new Set<string>();

        const stillActive = () => isMountedRef.current && currentAnimationRef.current === animationId;
        const cleanup = () => {
            if (currentAnimationRef.current === animationId) {
                currentAnimationRef.current = null;
            }
            unpinCurrentNodes();
            nodesRef.current.forEach(n => {
                n.isHighlighted = false;
                n.isFaded = false;
            });
            linksRef.current = linksRef.current.filter(l => {
                const src = typeof l.source === 'string' ? l.source : (l.source as GNode).id;
                const tgt = typeof l.target === 'string' ? l.target : (l.target as GNode).id;
                return !tempLinkKeys.has([src, tgt].sort().join('|'));
            });
            linksRef.current.forEach(l => { l.isAnimated = false; l.isActiveEdge = false; l.isFaded = false; });
            updateExpandedNodeId(null);
            updateInternalNodes({});
            updateActiveInternalIds(new Set());
            updateInternalParticle(null);
            isPlayingRef.current = false;
            if (isMountedRef.current) {
                setGraphState({ nodes: [...nodesRef.current], links: [...linksRef.current] });
                setIsPlaying(false);
            }
        };

        isPlayingRef.current = true;
        currentAnimationRef.current = animationId;
        setIsPlaying(true);
        setPopup(null);

        try {
            console.debug('[workflow] start', {
                submapCount: submaps.length,
                navigateToSubmap: flow.navigate_to_submap,
                availableSubmaps: submaps.map(s => s.name),
            });

            if (submaps.length === 0) {
                console.warn('[workflow] skipped: graph submaps are not loaded');
                return;
            }

            if (flow.navigate_to_submap && view !== flow.navigate_to_submap) {
                const targetSubmap = submaps.find(s => s.name === flow.navigate_to_submap);
                if (!targetSubmap) {
                    console.warn('[workflow] navigate_to_submap did not match any submap', {
                        requested: flow.navigate_to_submap,
                        available: submaps.map(s => s.name),
                    });
                } else {
                    loadSubmap(targetSubmap.name, true);
                    await waitForEngineStop(1800);
                    await sleep(150);
                }
            }
            if (!stillActive()) return;

            pinCurrentNodes();
            console.debug('[workflow] nodes after navigation', nodesRef.current.map(n => n.id));

            const findLeafFile = (nodeId: string) => {
                const preferredSubmap = submaps.find(s => s.name === flow.navigate_to_submap || s.name === view);
                return preferredSubmap?.files.find(f => f.fileName === nodeId)
                    ?? submaps.flatMap(s => s.files).find(f => f.fileName === nodeId);
            };

            const animateNodeInternals = async (nodeId: string, explicitSteps?: string[]) => {
                const targetNode = nodesRef.current.find(n => n.id === nodeId);
                if (!targetNode) return;

                const leafFile = findLeafFile(nodeId);
                const fallbackSteps = (leafFile?.leafNodes ?? [])
                    .map(node => node.id)
                    .filter(Boolean)
                    .slice(0, 5);
                const steps = (explicitSteps?.length ? explicitSteps : fallbackSteps).slice(0, 5);

                nodesRef.current.forEach(n => {
                    n.isFaded = n.id !== nodeId;
                    n.isHighlighted = n.id === nodeId;
                });
                linksRef.current.forEach(l => { l.isFaded = true; l.isAnimated = false; l.isActiveEdge = false; });
                focusNodes([nodeId], 1.22, Math.min(600, dur));
                forceCanvasRender();

                if (steps.length === 0) {
                    await sleep(Math.min(500, dur));
                    return;
                }

                const positions = computeInternalPositions(targetNode, steps, leafFile?.leafNodes ?? []);
                updateInternalNodes(positions);
                updateExpandedNodeId(nodeId);
                forceCanvasRender();
                await sleep(250);

                const internalDur = Math.max(Math.min(Math.floor(dur * 0.55), 650), 300);
                if (steps.length === 1) {
                    updateActiveInternalIds(new Set([steps[0]]));
                    await sleep(internalDur);
                }
                for (let i = 0; i < steps.length - 1; i++) {
                    if (!stillActive()) return;
                    updateActiveInternalIds(new Set([steps[i], steps[i + 1]]));
                    updateInternalParticle({ from: steps[i], to: steps[i + 1], startedAt: performance.now(), dur: internalDur });
                    await sleep(internalDur);
                }

                updateInternalParticle(null);
                updateActiveInternalIds(new Set());
                await sleep(180);
                updateExpandedNodeId(null);
                updateInternalNodes({});
            };

            const zoomTargetId = flow.zoom_to_node ?? flow.internal_flow?.node_label;
            if (zoomTargetId && graphRef.current) {
                const targetNode = nodesRef.current.find(n => n.id === zoomTargetId);
                if (!targetNode) {
                    console.warn('[workflow] zoom_to_node did not match a rendered node', {
                        requested: zoomTargetId,
                        available: nodesRef.current.map(n => n.id),
                    });
                } else {
                    nodesRef.current.forEach(n => {
                        n.isFaded = n.id !== zoomTargetId;
                        n.isHighlighted = n.id === zoomTargetId;
                    });
                    linksRef.current.forEach(l => { l.isFaded = true; l.isAnimated = false; l.isActiveEdge = false; });
                    forceCanvasRender();

                    focusNodes([targetNode.id], 1.35, 650);
                    await sleep(750);
                }
            }
            if (!stillActive()) return;

            const internalFlow = flow.internal_flow;
            if (internalFlow) {
                const targetId = internalFlow.node_label || zoomTargetId;
                const targetNode = targetId ? nodesRef.current.find(n => n.id === targetId) : undefined;
                if (!targetId || !targetNode) {
                    console.warn('[workflow] internal_flow target did not match a rendered node', {
                        requested: targetId,
                        available: nodesRef.current.map(n => n.id),
                    });
                } else {
                    const leafFile = findLeafFile(targetId);
                    console.debug('[workflow] target leaf nodes', {
                        file: targetId,
                        leafNodes: leafFile?.leafNodes ?? [],
                    });
                    await animateNodeInternals(targetId, internalFlow.steps);
                }
            }
            if (!stillActive()) return;

            const path = flow.paths?.[0];
            if (Array.isArray(path) && path.length > 1) {
                updateExpandedNodeId(null);
                updateInternalNodes({});
                updateInternalParticle(null);

                if (graphRef.current) {
                    graphRef.current.zoomToFit(600, 150);
                    await sleep(700);
                }

                for (let i = 0; i < path.length - 1; i++) {
                    const key = [path[i], path[i + 1]].sort().join('|');
                    const exists = linksRef.current.some(l => {
                        const src = typeof l.source === 'string' ? l.source : (l.source as GNode).id;
                        const tgt = typeof l.target === 'string' ? l.target : (l.target as GNode).id;
                        return [src, tgt].sort().join('|') === key;
                    });
                    if (!exists) {
                        linksRef.current.push({ source: path[i], target: path[i + 1] });
                        tempLinkKeys.add(key);
                    }
                }

                const animatedInternalNodes = new Set<string>();
                if (flow.internal_flow?.node_label) {
                    animatedInternalNodes.add(flow.internal_flow.node_label);
                }

                for (let step = 0; step < path.length - 1; step++) {
                    if (!stillActive()) return;
                    const srcNode = path[step];
                    const tgtNode = path[step + 1];
                    const activeKey = [srcNode, tgtNode].sort().join('|');

                    if (!animatedInternalNodes.has(srcNode)) {
                        await animateNodeInternals(srcNode);
                        animatedInternalNodes.add(srcNode);
                        if (!stillActive()) return;
                    }

                    nodesRef.current.forEach(n => {
                        n.isHighlighted = n.id === srcNode || n.id === tgtNode;
                        n.isFaded = n.id !== srcNode && n.id !== tgtNode;
                    });
                    linksRef.current.forEach(l => {
                        const src = typeof l.source === 'string' ? l.source : (l.source as GNode).id;
                        const tgt = typeof l.target === 'string' ? l.target : (l.target as GNode).id;
                        const key = [src, tgt].sort().join('|');
                        l.isAnimated = key === activeKey;
                        l.isActiveEdge = key === activeKey;
                        l.isFaded = key !== activeKey;
                        if (key === activeKey) {
                            l.animStart = performance.now();
                            l.animDur = dur;
                            l.animForward = src === srcNode;
                        }
                    });
                    focusNodes([srcNode, tgtNode], 1.05, Math.min(650, dur));
                    forceCanvasRender();
                    await sleep(dur);
                }

                const finalNode = path[path.length - 1];
                if (finalNode && !animatedInternalNodes.has(finalNode)) {
                    await animateNodeInternals(finalNode);
                }
            }

            await sleep(800);
        } finally {
            cleanup();
        }
    }, [
        forceCanvasRender,
        focusNodes,
        loadSubmap,
        pinCurrentNodes,
        submaps,
        updateActiveInternalIds,
        updateExpandedNodeId,
        updateInternalNodes,
        updateInternalParticle,
        unpinCurrentNodes,
        view,
        waitForEngineStop,
    ]);

    const runWorkflowAnimation = useCallback((flow: WorkflowFlow) => {
        void triggerAnimation({ flow });
    }, [triggerAnimation]);

    // ---------------------------------------------------------------------------
    // Handlers
    // ---------------------------------------------------------------------------

    const handleNodeClick = useCallback((node: any) => {
        if (isPlayingRef.current) return;
        const n = node as GNode;
        if (n.type === 'submap') loadSubmap(n.label);
        else if (graphRef.current) {
            const { x, y } = graphRef.current.graph2ScreenCoords(n.x ?? 0, n.y ?? 0);
            setPopup(prev => prev?.node.id === n.id ? null : { node: n, sx: x, sy: y });
        }
    }, [loadSubmap]);

    // TEAMMATE: pin node after drag
    const handleNodeDragEnd = useCallback((node: any) => {
        const n = node as GNode;
        n.fx = n.x; n.fy = n.y;
        setGraphState(({ nodes, links }) => ({ nodes: [...nodes], links: [...links] }));
    }, []);

    // TEAMMATE: zoom capping with min AND max bounds
    const handleEngineStop = useCallback(() => {
        engineStopResolverRef.current?.();
        engineStopResolverRef.current = null;
        if (isPlayingRef.current) return;

        if (!graphRef.current) return;
        graphRef.current.centerAt(0, 0, 250);
        graphRef.current.zoomToFit(400, isDomainView ? 72 : 78);
        setTimeout(() => {
            if (!graphRef.current) return;
            const current = graphRef.current.zoom();
            const maxZoom = isDomainView ? 1.02 : 1.08;
            const minZoom = isDomainView ? 0.74 : 0.88;
            if (current > maxZoom) graphRef.current.zoom(maxZoom, 300);
            else if (current < minZoom) graphRef.current.zoom(minZoom, 300);
        }, 450);
    }, [isDomainView]);

    // ---------------------------------------------------------------------------
    // Loading / error states
    // ---------------------------------------------------------------------------

    if (loading) {
        return (
            <div className="w-full h-screen bg-[#F3EEEA] flex items-center justify-center">
                <span className="text-[#776B5D] text-sm">Loading graph…</span>
            </div>
        );
    }

    if (error) {
        return (
            <div className="w-full h-screen bg-[#F3EEEA] flex items-center justify-center px-6">
                <span className="text-[#b42318] text-sm">Graph error: {error}</span>
            </div>
        );
    }

    // ---------------------------------------------------------------------------
    // Render
    // ---------------------------------------------------------------------------

    return (
        <div ref={containerRef} className="w-full h-screen bg-[#F3EEEA] relative overflow-hidden">

            {/* Top bar */}
            <div className="absolute top-0 left-0 right-0 z-20 flex items-center gap-3 px-5 py-4 bg-[#EBE3D5] border-b border-[#B0A695]">
                <AnimatePresence>
                    {!isDomainView && (
                        <motion.button key="back"
                                       initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }}
                                       onClick={() => { if (!isPlayingRef.current) loadDomain(); }}
                                       className="flex items-center gap-1.5 text-[#433b33] hover:text-[#221d18] text-sm font-medium"
                        >
                            <ArrowLeft className="h-4 w-4" /> All domains
                        </motion.button>
                    )}
                </AnimatePresence>
                <span className="text-[#433b33] font-bold text-lg">Codebase Map</span>
                {!isDomainView && (
                    <><span className="text-[#776B5D]">/</span>
                        <span className="text-[#433b33] font-semibold capitalize">{view}</span></>
                )}
                {isPlaying && (
                    <span className="ml-auto text-xs text-[#2F5D8C] animate-pulse font-semibold">
            Simulating workflow…
          </span>
                )}
            </div>

            {/* Canvas area */}
            <div className="absolute inset-0 pt-16">

                {/* TEAMMATE: floating back pill with file count */}
                <AnimatePresence>
                    {!isDomainView && (
                        <motion.button
                            initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }}
                            onClick={() => { if (!isPlayingRef.current) loadDomain(); }}
                            className="absolute left-5 top-20 z-20 flex items-center gap-2 rounded-full border border-[#B0A695] bg-[#DDD4C7] px-4 py-2 text-sm font-medium text-[#433b33] shadow-[3px_3px_0px_0px_rgba(0,0,0,0.8)] transition hover:-translate-y-0.5 hover:text-[#221d18]"
                        >
                            <ArrowLeft className="h-4 w-4" />
                            Back to domains
                            <span className="text-xs text-[#776B5D]">{currentSubmapFileCount} files</span>
                        </motion.button>
                    )}
                </AnimatePresence>

                <ForceGraph2D
                    ref={graphRef}
                    graphData={graphState}
                    width={dims.w} height={dims.h}
                    backgroundColor={C.bg}
                    nodeCanvasObject={(node, ctx, scale) => drawNode(
                        node as GNode,
                        ctx,
                        scale,
                        phaseRef.current,
                        expandedNodeIdRef.current,
                        internalNodesRef.current,
                        activeInternalIdsRef.current,
                        internalParticleRef.current
                    )}
                    nodeCanvasObjectMode={() => 'replace'}
                    nodeVal={(n: any) => n.id === expandedNodeId ? 120 : (n.type === 'submap' ? 70 : 35)}
                    nodePointerAreaPaint={(n: any, color, ctx) => {
                        const isExpanded = n.id === expandedNodeId && n.type === 'file';
                        const w = isExpanded ? 280 : (n.type === 'submap' ? 220 : 160);
                        const h = isExpanded ? 300 : (n.type === 'submap' ? 120 : 48);
                        ctx.fillStyle = color;
                        ctx.fillRect((n.x ?? 0) - w / 2, (n.y ?? 0) - h / 2, w, h);
                    }}
                    onNodeClick={handleNodeClick}
                    onNodeDragEnd={handleNodeDragEnd}
                    linkColor={(l: any) =>
                        l.isFaded ? '#B0A69544'
                            : (l.isAnimated || l.isActiveEdge) ? '#2F5D8C'
                                : isDomainView ? '#776B5Daa' : '#8f8377'
                    }
                    linkWidth={(l: any) => (l.isAnimated || l.isActiveEdge) ? 2.5 : isDomainView ? 1.35 : 1.15}
                    linkCurvature={isDomainView ? 0.05 : 0.1}
                    linkDirectionalParticles={(l: any) => l.isAnimated ? 1 : 0}
                    linkDirectionalParticleWidth={0}
                    linkCanvasObjectMode={() => 'after'}
                    // YOUR: directional dot animation with animForward
                    linkCanvasObject={(l: any, ctx, scale) => {
                        if (!l.isAnimated || !l.animStart) return;
                        const start = l.animForward ? l.source : l.target;
                        const end   = l.animForward ? l.target : l.source;
                        const t   = performance.now() - l.animStart;
                        const dur = l.animDur ?? 1000;
                        const p1  = t / dur;
                        const p2  = p1 - 300 / dur;

                        const drawDot = (p: number, r: number, color: string, glow: boolean) => {
                            if (p < 0 || p > 1) return;
                            const x = start.x + (end.x - start.x) * p;
                            const y = start.y + (end.y - start.y) * p;
                            ctx.beginPath();
                            ctx.arc(x, y, r / scale, 0, 2 * Math.PI, false);
                            ctx.fillStyle = color;
                            ctx.shadowColor = glow ? color : 'transparent';
                            ctx.shadowBlur = glow ? 6 / scale : 0;
                            ctx.fill();
                        };

                        ctx.save();
                        drawDot(p1, 5, '#2F5D8C', true);
                        drawDot(p2, 3, '#6D8EAA', false);
                        ctx.restore();
                    }}
                    warmupTicks={100}
                    onEngineStop={handleEngineStop}
                />
            </div>

            {/* File node popup */}
            <AnimatePresence>
                {popup && (
                    <motion.div
                        initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }}
                        className="absolute z-30 w-72 rounded-xl border border-[#B0A695] bg-[#EBE3D5] shadow-[6px_6px_0_#000] p-4"
                        style={{ left: popup.sx + 16, top: popup.sy - 40 }}
                        onMouseDown={e => e.stopPropagation()}
                    >
                        <button className="absolute top-2 right-2 text-[#776B5D] hover:text-[#433b33]" onClick={() => setPopup(null)}>
                            <X className="h-4 w-4" />
                        </button>
                        <p className="text-xs font-bold text-[#776B5D] uppercase mb-1">Directory</p>
                        <p className="text-sm font-mono text-[#433b33] mb-3 break-all">{popup.node.directory}</p>
                        <p className="text-xs font-bold text-[#776B5D] uppercase mb-1">Functionality</p>
                        <p className="text-sm text-[#433b33] leading-relaxed">{popup.node.functionality}</p>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* TEAMMATE: ChatPanel with RAG scope + YOUR: workflow trigger on query */}
            <ChatPanel
                repoId={repoId}
                scope={currentScope}
                isAnimating={isPlaying}
                onWorkflowResponse={(flow) => {
                    runWorkflowAnimation(flow);
                }}
            />
        </div>
    );
}
