"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import dagre from '@dagrejs/dagre';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, HelpCircle, X } from 'lucide-react';
import { forceCollide, forceX, forceY } from 'd3-force';
import { ChatPanel } from './ChatPanel';
import {
    fetchGraphData,
    getRepoStatus,
    type BackendCluster,
    type BackendLeaf,
    type BackendNode,
    type BackendTree,
    type GraphData,
    type WorkflowFlow,
    type WorkflowSegment,
} from './adapter';
import workflowData from '@/workflow_test.json'; // YOUR: workflow animation data

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
    id: string; type: 'cluster' | 'file'; label: string;
    fileCount?: number; directory?: string; functionality?: string;
    treeNode?: BackendTree;
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

function isCluster(node: BackendTree | null | undefined): node is BackendCluster {
    return node?.type === 'cluster';
}

function isLeaf(node: BackendTree | null | undefined): node is BackendLeaf {
    return node?.type === 'leaf';
}

function collectLeaves(node: BackendTree): BackendLeaf[] {
    if (node.type === 'leaf') return [node];
    return node.children.flatMap(collectLeaves);
}

function collectClusters(node: BackendTree): BackendCluster[] {
    if (node.type === 'leaf') return [];
    return [node, ...node.children.flatMap(collectClusters)];
}

function countLeaves(node: BackendTree): number {
    return node.type === 'leaf' ? 1 : node.children.reduce((sum, child) => sum + countLeaves(child), 0);
}

function findClusterPathByLabel(root: BackendTree | null, label: string): BackendCluster[] | null {
    if (!isCluster(root)) return null;

    const visit = (node: BackendCluster, path: BackendCluster[]): BackendCluster[] | null => {
        const nextPath = [...path, node];
        if (node.label === label) return nextPath;

        for (const child of node.children) {
            if (!isCluster(child)) continue;
            const found = visit(child, nextPath);
            if (found) return found;
        }

        return null;
    };

    return visit(root, []);
}

function findClusterPathById(root: BackendTree | null, id: string | undefined): BackendCluster[] | null {
    if (!isCluster(root) || !id) return null;

    const visit = (node: BackendCluster, path: BackendCluster[]): BackendCluster[] | null => {
        const nextPath = [...path, node];
        if (node.id === id) return nextPath;

        for (const child of node.children) {
            if (!isCluster(child)) continue;
            const found = visit(child, nextPath);
            if (found) return found;
        }

        return null;
    };

    return visit(root, []);
}

function findClusterPathContainingLeaf(root: BackendTree | null, leafLabel: string): BackendCluster[] | null {
    if (!isCluster(root)) return null;

    const visit = (node: BackendCluster, path: BackendCluster[]): BackendCluster[] | null => {
        const nextPath = [...path, node];
        for (const child of node.children) {
            if (isLeaf(child) && child.label === leafLabel) return nextPath;
            if (isCluster(child)) {
                const found = visit(child, nextPath);
                if (found) return found;
            }
        }
        return null;
    };

    return visit(root, []);
}

function findLeafByLabel(root: BackendTree | null, label: string): BackendLeaf | null {
    if (!root) return null;
    if (isLeaf(root)) return root.label === label ? root : null;
    for (const child of root.children) {
        const found = findLeafByLabel(child, label);
        if (found) return found;
    }
    return null;
}

function getTreeNodeGraphId(node: BackendTree): string {
    return node.id ?? (isLeaf(node) ? node.file_path : node.label);
}

function resolveDirectChildId(cluster: BackendCluster, endpointLabel: string): string | null {
    const direct = cluster.children.find(child => child.label === endpointLabel);
    if (direct) return getTreeNodeGraphId(direct);

    for (const child of cluster.children) {
        if (isCluster(child)) {
            const descendantLabels = collectLeaves(child).map(leaf => leaf.label);
            const descendantClusterLabels = collectClusters(child).map(n => n.label);
            if (descendantLabels.includes(endpointLabel) || descendantClusterLabels.includes(endpointLabel)) {
                return getTreeNodeGraphId(child);
            }
        }
    }

    return null;
}

const NODE_WIDTH_CLUSTER = 220;
const NODE_HEIGHT_CLUSTER = 120;
const NODE_WIDTH_FILE = 160;
const NODE_HEIGHT_FILE = 48;

function computeDagrePositions(
    nodes: GNode[],
    links: GLink[],
    isRootLayer: boolean
): GNode[] {
    if (nodes.length === 0) return nodes;

    const g = new dagre.graphlib.Graph();
    g.setDefaultEdgeLabel(() => ({}));
    g.setGraph({
        rankdir: 'LR',
        nodesep: isRootLayer ? 80 : 60,
        ranksep: isRootLayer ? 140 : 100,
        marginx: 40,
        marginy: 40,
    });

    nodes.forEach(node => {
        const width = node.type === 'cluster' ? NODE_WIDTH_CLUSTER : NODE_WIDTH_FILE;
        const height = node.type === 'cluster' ? NODE_HEIGHT_CLUSTER : NODE_HEIGHT_FILE;
        g.setNode(node.id, { width, height });
    });

    links.forEach(link => {
        const source = typeof link.source === 'string' ? link.source : (link.source as GNode).id;
        const target = typeof link.target === 'string' ? link.target : (link.target as GNode).id;
        if (g.hasNode(source) && g.hasNode(target)) {
            g.setEdge(source, target);
        }
    });

    try {
        dagre.layout(g);
    } catch {
        return nodes;
    }

    const positioned = nodes
        .map(node => {
            const pos = g.node(node.id);
            return pos ? { node, x: pos.x, y: pos.y } : null;
        })
        .filter((item): item is { node: GNode; x: number; y: number } => item !== null);

    if (positioned.length === 0) return nodes;

    const minX = Math.min(...positioned.map(item => item.x));
    const maxX = Math.max(...positioned.map(item => item.x));
    const minY = Math.min(...positioned.map(item => item.y));
    const maxY = Math.max(...positioned.map(item => item.y));
    const offsetX = (minX + maxX) / 2;
    const offsetY = (minY + maxY) / 2;
    const positionById = new Map(positioned.map(item => [item.node.id, item]));

    return nodes.map(node => {
        const pos = positionById.get(node.id);
        if (!pos) return node;

        const x = pos.x - offsetX;
        const y = pos.y - offsetY;
        return {
            ...node,
            x,
            y,
            fx: x,
            fy: y,
            vx: 0,
            vy: 0,
        };
    });
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

    const isSubmap = node.type === 'cluster';
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
        ctx.fillText('Click to explore this layer >', x + 16, y + 104);
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
    const [graphState, setGraphState] = useState<{ nodes: GNode[]; links: GLink[]; _render?: number }>({ nodes: [], links: [] });
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const [clusterStack, setClusterStack] = useState<BackendCluster[]>([]);
    const [isPlaying, setIsPlaying] = useState(false);
    const [expandedNodeId, setExpandedNodeId] = useState<string | null>(null);
    const [internalNodes, setInternalNodes] = useState<Record<string, InternalNodePos>>({});
    const [activeInternalIds, setActiveInternalIds] = useState<Set<string>>(new Set());
    const [internalParticle, setInternalParticle] = useState<InternalParticle | null>(null);
    const [popup, setPopup] = useState<{ node: GNode; sx: number; sy: number } | null>(null);
    const [repoName, setRepoName] = useState<string | null>(null);
    const [showHelp, setShowHelp] = useState(false);
    const [dims, setDims] = useState({ w: 800, h: 600 });

    const nodesRef = useRef<GNode[]>([]);
    const linksRef = useRef<GLink[]>([]);
    const phaseRef = useRef(0);
    const renderCountRef = useRef(0);
    const graphRef = useRef<any>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const isPlayingRef = useRef(false);
    const isMountedRef = useRef(true);
    const currentAnimationRef = useRef<symbol | null>(null);
    const engineStopResolverRef = useRef<(() => void) | null>(null);
    const suppressNextInitialFitRef = useRef(false);
    const fitTimeoutRef = useRef<number | null>(null);
    const expandedNodeIdRef = useRef<string | null>(null);
    const internalNodesRef = useRef<Record<string, InternalNodePos>>({});
    const activeInternalIdsRef = useRef<Set<string>>(new Set());
    const internalParticleRef = useRef<InternalParticle | null>(null);

    const rootCluster = useMemo(() => (isCluster(graphData) ? graphData : null), [graphData]);
    const currentCluster = clusterStack.length > 0 ? clusterStack[clusterStack.length - 1] : rootCluster;
    const isDomainView = Boolean(rootCluster && currentCluster?.label === rootCluster.label);
    const canGoBack = clusterStack.length > 1;
    const currentLayerCount = currentCluster?.children.length ?? (graphData ? 1 : 0);
    const currentLeafCount = currentCluster ? countLeaves(currentCluster) : (graphData ? countLeaves(graphData) : 0);
    const totalFileCount = graphData ? countLeaves(graphData) : 0;
    const breadcrumb = clusterStack.map(cluster => cluster.label);
    const clusters = useMemo(() => graphData ? collectClusters(graphData) : [], [graphData]);

    // Current view label is shown in chat, but chat requests are global by default.
    const currentScope = useMemo(() => {
        if (!graphData || !currentCluster || isDomainView) return { id: undefined, label: 'Root' };
        return { id: currentCluster.id, label: currentCluster.label };
    }, [currentCluster, graphData, isDomainView]);

    const forceCanvasRender = useCallback(() => {
        renderCountRef.current += 1;
        setGraphState(prev => ({ ...prev, _render: renderCountRef.current }));
    }, []);

    const clearFitTimeout = useCallback(() => {
        if (fitTimeoutRef.current !== null) {
            window.clearTimeout(fitTimeoutRef.current);
            fitTimeoutRef.current = null;
        }
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
        if (graphRef.current) {
            graphRef.current.d3AlphaTarget?.(0);
            graphRef.current.d3Force?.('charge')?.strength?.(0);
            graphRef.current.d3Force?.('x')?.strength?.(0);
            graphRef.current.d3Force?.('y')?.strength?.(0);
            graphRef.current.d3Force?.('collision')?.radius?.(0);
        }
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

    const focusNodes = useCallback((nodeIds: string[], zoom = 1.06, duration = 650): number => {
        if (!graphRef.current || nodeIds.length === 0) return 0;

        const selected = nodesRef.current.filter(n => nodeIds.includes(n.id));
        if (selected.length === 0) return 0;

        const centerX = selected.reduce((sum, node) => sum + (node.x ?? 0), 0) / selected.length;
        const centerY = selected.reduce((sum, node) => sum + (node.y ?? 0), 0) / selected.length;

        graphRef.current.centerAt(centerX, centerY, duration);
        graphRef.current.zoom(zoom, duration);
        return duration;
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

    useEffect(() => {
        let cancelled = false;
        getRepoStatus(repoId)
            .then(status => {
                if (!cancelled) setRepoName(status.name ?? status.github_url ?? null);
            })
            .catch(() => {
                if (!cancelled) setRepoName(null);
            });
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
            clearFitTimeout();
        };
    }, [clearFitTimeout]);

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
            const graph = graphRef.current;
            if (typeof graph?.refresh === 'function') {
                graph.refresh();
            } else {
                forceCanvasRender();
            }
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [expandedNodeId, forceCanvasRender, isPlaying]);

    // ---------------------------------------------------------------------------
    // applyGraph — TEAMMATE forces (collision, x, y) + YOUR charge/distance values
    // ---------------------------------------------------------------------------

    const applyGraph = (nodes: GNode[], links: GLink[], isRootLayer: boolean = false) => {
        const shouldAutoFit = !suppressNextInitialFitRef.current && !isPlayingRef.current;
        suppressNextInitialFitRef.current = false;
        clearFitTimeout();

        const positionedNodes = computeDagrePositions(nodes, links, isRootLayer);

        nodesRef.current = positionedNodes;
        linksRef.current = links;
        setGraphState({ nodes: positionedNodes, links });

        if (!isPlayingRef.current) {
            graphRef.current?.d3ReheatSimulation();
        }

        if (graphRef.current) graphRef.current.zoom(0.8, 0);

        if (shouldAutoFit) {
            fitTimeoutRef.current = window.setTimeout(() => {
                fitTimeoutRef.current = null;
                if (!graphRef.current || isPlayingRef.current) return;
                graphRef.current.zoomToFit(600, isRootLayer ? 80 : 90);
            }, 120);
        }

        setTimeout(() => {
            if (!graphRef.current) return;
            graphRef.current.d3Force('charge').strength(isRootLayer ? -2200 : -560);
            graphRef.current.d3Force('link').distance(isRootLayer ? 165 : 108);
            graphRef.current.d3Force('collision', forceCollide(isRootLayer ? 112 : 82));
            graphRef.current.d3Force('x', forceX(0).strength(isRootLayer ? 0.04 : 0.11));
            graphRef.current.d3Force('y', forceY(0).strength(isRootLayer ? 0.04 : 0.11));

            if (!isPlayingRef.current) {
                setTimeout(() => {
                    nodesRef.current.forEach(node => {
                        node.fx = undefined;
                        node.fy = undefined;
                    });
                }, 300);
            }
        }, 10);
    };

    // ---------------------------------------------------------------------------
    // Navigation
    // ---------------------------------------------------------------------------

    const buildLayerGraph = useCallback((cluster: BackendCluster | null) => {
        if (!cluster) {
            return { nodes: [], links: [] };
        }

        const nodes: GNode[] = cluster.children.map(child => {
            if (isCluster(child)) {
                return {
                    id: getTreeNodeGraphId(child),
                    type: 'cluster' as const,
                    label: child.label,
                    fileCount: countLeaves(child),
                    functionality: child.summary,
                    treeNode: child,
                };
            }

            return {
                id: getTreeNodeGraphId(child),
                type: 'file' as const,
                label: child.label,
                directory: child.file_path,
                functionality: child.summary,
                treeNode: child,
            };
        });

        const visibleIds = new Set(nodes.map(node => node.id));
        const seen = new Set<string>();
        const links: GLink[] = [];

        for (const edge of cluster.edges ?? []) {
            const source = resolveDirectChildId(cluster, edge.from);
            const target = resolveDirectChildId(cluster, edge.to);
            if (!source || !target || source === target) continue;
            if (!visibleIds.has(source) || !visibleIds.has(target)) continue;
            const key = [source, target].sort().join('|');
            if (seen.has(key)) continue;
            seen.add(key);
            links.push({ source, target });
        }

        return { nodes, links };
    }, []);

    const loadClusterPath = useCallback((path: BackendCluster[], preservePlayback = false) => {
        if (path.length === 0) return;
        setClusterStack(path);
        if (!preservePlayback) setIsPlaying(false);
        setPopup(null);
        updateExpandedNodeId(null);
        updateInternalNodes({});
        updateActiveInternalIds(new Set());
        updateInternalParticle(null);
        const target = path[path.length - 1];
        const { nodes, links } = buildLayerGraph(target);
        applyGraph(nodes, links, path.length === 1);
    }, [buildLayerGraph, updateActiveInternalIds, updateExpandedNodeId, updateInternalNodes, updateInternalParticle]);

    const loadDomain = useCallback((preservePlayback = false) => {
        if (!rootCluster) return;
        loadClusterPath([rootCluster], preservePlayback);
    }, [loadClusterPath, rootCluster]);

    const loadClusterByLabel = useCallback((label: string, preservePlayback = false) => {
        const path = findClusterPathByLabel(rootCluster, label);
        if (!path) return;
        loadClusterPath(path, preservePlayback);
    }, [loadClusterPath, rootCluster]);

    const loadChildCluster = useCallback((cluster: BackendCluster, preservePlayback = false) => {
        const path = findClusterPathById(rootCluster, cluster.id) ?? findClusterPathByLabel(rootCluster, cluster.label);
        if (path) {
            loadClusterPath(path, preservePlayback);
        }
    }, [loadClusterPath, rootCluster]);

    const loadParentLayer = useCallback(() => {
        if (isPlayingRef.current || clusterStack.length <= 1) return;
        loadClusterPath(clusterStack.slice(0, -1));
    }, [clusterStack, loadClusterPath]);

    useEffect(() => {
        if (!rootCluster) {
            if (isLeaf(graphData)) {
                const node: GNode = {
                    id: getTreeNodeGraphId(graphData),
                    type: 'file',
                    label: graphData.label,
                    directory: graphData.file_path,
                    functionality: graphData.summary,
                    treeNode: graphData,
                };
                nodesRef.current = [node];
                linksRef.current = [];
                setGraphState({ nodes: [node], links: [] });
            }
            return;
        }
        loadClusterPath([rootCluster]);
    }, [graphData, loadClusterPath, rootCluster]);

    // TEAMMATE: Escape key exits submap view
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (isPlayingRef.current) return;
            if (e.key === 'Escape' && canGoBack) { setPopup(null); loadParentLayer(); }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [canGoBack, loadParentLayer]);

    // ---------------------------------------------------------------------------
    // YOUR: Workflow animation — reads workflowData.flow.paths[0]
    // Keeps isActiveEdge (cyan edge persists after particle), animForward (correct direction)
    // ---------------------------------------------------------------------------

    const triggerAnimation = useCallback(async (workflowOverride?: WorkflowAnimationPayload) => {
        if (isPlayingRef.current) return;

        const fallbackWorkflow = workflowData as WorkflowAnimationPayload;
        const flow = (workflowOverride ?? fallbackWorkflow).flow;
        const animationId = Symbol('workflow-animation');

        // Normalize to segments array. If backend sent segments[], use them.
        // Otherwise wrap the single-segment legacy fields so the loop below
        // handles both shapes identically.
        const segments: WorkflowSegment[] = (flow.segments && flow.segments.length > 0)
            ? flow.segments.map(seg => ({
                ...seg,
                // Each segment inherits top-level step_duration_ms if not set.
                step_duration_ms: seg.step_duration_ms ?? flow.step_duration_ms ?? 1000,
            }))
            : [{
                navigate_to_submap: flow.navigate_to_submap,
                navigate_to_submap_id: flow.navigate_to_submap_id,
                zoom_to_node: flow.zoom_to_node,
                paths: flow.paths ?? [],
                internal_flow: flow.internal_flow,
                loop: flow.loop ?? false,
                step_duration_ms: flow.step_duration_ms ?? 1000,
            }];
        const dur = Math.max(typeof flow.step_duration_ms === 'number' ? flow.step_duration_ms : 1000, 400);
        const tempLinkKeys = new Set<string>();

        const stillActive = () => isMountedRef.current && currentAnimationRef.current === animationId;
        const cleanup = () => {
            if (currentAnimationRef.current === animationId) {
                currentAnimationRef.current = null;
            }
            clearFitTimeout();
            unpinCurrentNodes();
            nodesRef.current.forEach(n => {
                n.vx = 0;
                n.vy = 0;
            });
            const isRoot = clusterStack.length <= 1;
            if (graphRef.current) {
                graphRef.current.d3Force('charge')?.strength(isRoot ? -2200 : -560);
                graphRef.current.d3Force('link')?.distance(isRoot ? 165 : 108);
                graphRef.current.d3Force('collision', forceCollide(isRoot ? 112 : 82));
                graphRef.current.d3Force('x', forceX(0).strength(isRoot ? 0.04 : 0.11));
                graphRef.current.d3Force('y', forceY(0).strength(isRoot ? 0.04 : 0.11));
                window.setTimeout(() => {
                    graphRef.current?.d3ReheatSimulation();
                }, 150);
            }
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
            window.setTimeout(() => {
                if (!graphRef.current || isPlayingRef.current) return;
                graphRef.current.zoomToFit(650, 130);
            }, 220);
        };

        isPlayingRef.current = true;
        // Freeze physics without pausing canvas rendering; particles and glow
        // still need the graph canvas to repaint every frame.
        graphRef.current?.d3AlphaTarget?.(0);
        graphRef.current?.d3Force?.('charge')?.strength?.(0);
        graphRef.current?.d3Force?.('x')?.strength?.(0);
        graphRef.current?.d3Force?.('y')?.strength?.(0);
        graphRef.current?.d3Force?.('collision')?.radius?.(0);
        currentAnimationRef.current = animationId;
        clearFitTimeout();
        setIsPlaying(true);
        setPopup(null);

        try {
            console.debug('[workflow] start', {
                segmentCount: segments.length,
                clusterCount: clusters.length,
                availableClusters: clusters.map(s => s.label),
            });

            if (!rootCluster || clusters.length === 0) {
                console.warn('[workflow] skipped: graph clusters are not loaded');
                return;
            }

            let activeView = currentCluster?.label ?? rootCluster.label;
            let activeClusterId = currentCluster?.id ?? rootCluster.id;
            const ORPHAN_SENTINEL = '__orphan__';
            const fileToSubmap = new Map<string, string>();
            clusters.forEach(cluster => {
                collectLeaves(cluster).forEach(leaf => {
                    if (!fileToSubmap.has(leaf.label) || countLeaves(cluster) < countLeaves(clusters.find(c => c.label === fileToSubmap.get(leaf.label)) ?? rootCluster)) {
                        fileToSubmap.set(leaf.label, cluster.label);
                    }
                });
            });
            rootCluster.children.forEach(child => {
                if (child.type === 'leaf') {
                    fileToSubmap.set(child.label, ORPHAN_SENTINEL);
                }
            });

            const getLinkKey = (from: string, to: string) => [from, to].sort().join('|');
            const getEndpointId = (endpoint: string | GNode) => typeof endpoint === 'string' ? endpoint : endpoint.id;
            const findRenderedNode = (labelOrId: string | null | undefined) => {
                if (!labelOrId) return undefined;
                return nodesRef.current.find(n => n.id === labelOrId || n.label === labelOrId);
            };
            const renderedIdFor = (labelOrId: string | null | undefined) => findRenderedNode(labelOrId)?.id;
            const topVisibleClusterLabel = (label: string | null) => {
                if (!label) return null;
                const path = findClusterPathByLabel(rootCluster, label);
                if (!path) return label;
                return path[1]?.label ?? path[0]?.label ?? label;
            };

            const animateDomainHop = async (_fromSubmap: string | null, toSubmap: string, toSubmapId?: string | null) => {
                if (!stillActive()) return;
                const targetPath = toSubmapId
                    ? findClusterPathById(rootCluster, toSubmapId)
                    : findClusterPathByLabel(rootCluster, toSubmap);
                const targetCluster = targetPath?.[targetPath.length - 1];
                if (!targetCluster) return;

                if (activeView !== rootCluster.label) {
                    if (graphRef.current) {
                        graphRef.current.zoom(0.5, 500);
                        await sleep(400);
                    }
                    if (!stillActive()) return;

                    suppressNextInitialFitRef.current = true;
                    loadDomain(true);
                    activeView = rootCluster.label;
                    activeClusterId = rootCluster.id;
                    await sleep(600);
                    if (!stillActive()) return;

                    if (graphRef.current) {
                        graphRef.current.zoomToFit(500, 80);
                        await sleep(550);
                    }
                    if (!stillActive()) return;
                }

                pinCurrentNodes();
                const visibleToLabel = topVisibleClusterLabel(targetCluster.label) ?? targetCluster.label;
                const visibleTo = renderedIdFor(visibleToLabel) ?? visibleToLabel;
                nodesRef.current.forEach(n => {
                    n.isHighlighted = n.id === visibleTo;
                    n.isFaded = n.id !== visibleTo;
                });
                linksRef.current.forEach(l => {
                    l.isFaded = true;
                    l.isAnimated = false;
                    l.isActiveEdge = false;
                });
                forceCanvasRender();
                await sleep(700);
                if (!stillActive()) return;

                const targetNode = nodesRef.current.find(n => n.id === visibleTo);
                if (targetNode && graphRef.current) {
                    graphRef.current.centerAt(targetNode.x ?? 0, targetNode.y ?? 0, 600);
                    await sleep(400);
                    if (!stillActive()) return;

                    graphRef.current.zoom(1.8, 500);
                    await sleep(400);
                    if (!stillActive()) return;

                    graphRef.current.zoom(3.5, 500);
                    await sleep(400);
                    if (!stillActive()) return;
                }

                if (graphRef.current) {
                    graphRef.current.zoom(0.3, 0);
                }

                suppressNextInitialFitRef.current = true;
                loadClusterPath(targetPath, true);
                activeView = targetCluster.label;
                activeClusterId = targetCluster.id;
                await sleep(300);
                if (!stillActive()) return;

                if (graphRef.current) {
                    graphRef.current.zoomToFit(700, 90);
                    await sleep(750);
                }
                if (!stillActive()) return;

                pinCurrentNodes();
                await sleep(100);
            };

            const goToSubmap = async (targetSubmapName: string, targetSubmapId?: string | null) => {
                if (!stillActive()) return;
                const targetPath = targetSubmapId
                    ? findClusterPathById(rootCluster, targetSubmapId)
                    : findClusterPathByLabel(rootCluster, targetSubmapName);
                if (!targetPath) {
                    console.warn('[workflow] cluster did not match any available cluster', {
                        requested: targetSubmapName,
                        requestedId: targetSubmapId,
                        available: clusters.map(s => s.label),
                    });
                    return;
                }

                const targetCluster = targetPath[targetPath.length - 1];
                if (activeClusterId !== targetCluster.id) {
                    await animateDomainHop(activeView === rootCluster.label ? null : activeView, targetCluster.label, targetCluster.id);
                }
                activeView = targetCluster.label;
                activeClusterId = targetCluster.id;

                pinCurrentNodes();
                await sleep(100);
            };

            const findLeafFile = (nodeLabelOrId: string) => {
                const rendered = findRenderedNode(nodeLabelOrId);
                if (isLeaf(rendered?.treeNode)) return rendered.treeNode;
                return findLeafByLabel(rootCluster, nodeLabelOrId);
            };

            const animateNodeInternals = async (nodeLabelOrId: string, explicitSteps?: string[], segDur?: number) => {
                const targetNode = findRenderedNode(nodeLabelOrId);
                if (!targetNode) return;
                const nodeId = targetNode.id;

                const leafFile = findLeafFile(nodeLabelOrId);
                const fallbackSteps = (leafFile?.nodes ?? [])
                    .map(node => node.id)
                    .filter(Boolean)
                    .slice(0, 5);
                const steps = (explicitSteps?.length ? explicitSteps : fallbackSteps).slice(0, 5);
                const stepDur = segDur ?? dur;

                nodesRef.current.forEach(n => {
                    n.isFaded = n.id !== nodeId;
                    n.isHighlighted = n.id === nodeId;
                });
                linksRef.current.forEach(l => {
                    l.isFaded = true;
                    l.isAnimated = false;
                    l.isActiveEdge = false;
                    l.animStart = undefined;
                    l.animDur = undefined;
                });
                const cameraDur = focusNodes([nodeId], 1.08, Math.min(600, stepDur));
                forceCanvasRender();

                if (steps.length === 0) {
                    await sleep(Math.max(Math.min(500, stepDur), cameraDur + 50));
                    return;
                }

                const positions = computeInternalPositions(targetNode, steps, leafFile?.nodes ?? []);
                updateInternalNodes(positions);
                updateExpandedNodeId(nodeId);
                forceCanvasRender();
                await sleep(Math.max(250, cameraDur + 50));

                const internalDur = Math.max(Math.min(Math.floor(stepDur * 0.55), 650), 300);
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

            // ── Iterate segments ──────────────────────────────────────────────────
            // Each segment is an independent animation unit: navigate → zoom → internals → paths.
            // Between segments we pause briefly so the user can register the transition.
            const animatedInternalNodes = new Set<string>();

            for (let segIdx = 0; segIdx < segments.length; segIdx++) {
                if (!stillActive()) break;
                const seg = segments[segIdx];
                const segDur = Math.max(seg.step_duration_ms ?? dur, 400);

                console.debug(`[workflow] segment ${segIdx + 1}/${segments.length}`, {
                    navigate_to_submap: seg.navigate_to_submap,
                    zoom_to_node: seg.zoom_to_node,
                });

                // Phase 1: Navigate to the segment's submap.
                // null means a root-level orphan leaf that is already visible
                // in domain view; undefined falls back to file-to-cluster lookup.
                const zoomTargetId = seg.zoom_to_node ?? seg.internal_flow?.node_label;
                const explicitSubmap = Object.prototype.hasOwnProperty.call(seg, 'navigate_to_submap')
                    ? seg.navigate_to_submap
                    : undefined;
                const explicitSubmapId = Object.prototype.hasOwnProperty.call(seg, 'navigate_to_submap_id')
                    ? seg.navigate_to_submap_id
                    : undefined;
                const inferredSubmap = zoomTargetId ? fileToSubmap.get(zoomTargetId) : undefined;
                const targetSubmapName = explicitSubmap === null
                    ? null
                    : (explicitSubmap ?? inferredSubmap ?? undefined);

                if (targetSubmapName === null || targetSubmapName === ORPHAN_SENTINEL) {
                    if (activeView !== rootCluster.label) {
                        suppressNextInitialFitRef.current = true;
                        loadDomain(true);
                        activeView = rootCluster.label;
                        activeClusterId = rootCluster.id;
                        await waitForEngineStop(1800);
                        if (!stillActive()) break;
                    }
                    pinCurrentNodes();
                } else if (targetSubmapName) {
                    const targetPath = explicitSubmapId
                        ? findClusterPathById(rootCluster, explicitSubmapId)
                        : findClusterPathByLabel(rootCluster, targetSubmapName);
                    const targetCluster = targetPath?.[targetPath.length - 1];
                    if (targetPath && activeClusterId !== targetCluster?.id) {
                        await goToSubmap(targetSubmapName, explicitSubmapId);
                    } else if (!targetPath) {
                        console.warn('[workflow] navigate_to_submap did not match any cluster - staying at current view', {
                            requested: targetSubmapName,
                            requestedId: explicitSubmapId,
                        });
                    }
                }
                if (!stillActive()) break;

                // Phase 2: Zoom to the target node.
                if (zoomTargetId && graphRef.current) {
                    const targetNode = findRenderedNode(zoomTargetId);
                    if (!targetNode) {
                        console.warn('[workflow] zoom_to_node did not match a rendered node', {
                            requested: zoomTargetId,
                            available: nodesRef.current.map(n => ({ id: n.id, label: n.label })),
                        });
                    } else {
                        nodesRef.current.forEach(n => {
                            n.isFaded = n.id !== targetNode.id;
                            n.isHighlighted = n.id === targetNode.id;
                        });
                        linksRef.current.forEach(l => { l.isFaded = true; l.isAnimated = false; l.isActiveEdge = false; });
                        forceCanvasRender();
                        const cameraDur = focusNodes([targetNode.id], 1.12, 650);
                        await sleep(Math.max(750, cameraDur + 50));
                    }
                }
                if (!stillActive()) break;

                // Phase 3: Animate internals for the target node.
                const internalFlow = seg.internal_flow;
                if (internalFlow) {
                    const targetId = internalFlow.node_label || zoomTargetId;
                    const targetNode = findRenderedNode(targetId);
                    if (!targetId || !targetNode) {
                        console.warn('[workflow] internal_flow target did not match a rendered node', {
                            requested: targetId,
                            available: nodesRef.current.map(n => ({ id: n.id, label: n.label })),
                        });
                    } else {
                        await animateNodeInternals(targetId, internalFlow.steps, segDur);
                        animatedInternalNodes.add(targetId);
                    }
                }
                if (!stillActive()) break;

                // Phase 4: Animate cross-node paths within this segment.
                const path = seg.paths?.[0];
                if (Array.isArray(path) && path.length > 1) {
                    updateExpandedNodeId(null);
                    updateInternalNodes({});
                    updateInternalParticle(null);

                    if (graphRef.current) {
                        // First center on all visible nodes, then fit with enough padding
                        // to make the zoom-out feel like pulling back rather than jumping.
                        const allIds = nodesRef.current.map(n => n.id);
                        focusNodes(allIds, 0.85, 500);
                        await sleep(600);
                    }

                    for (let step = 0; step < path.length - 1; step++) {
                        if (!stillActive()) break;
                        const srcNode = path[step];
                        const tgtNode = path[step + 1];
                        const srcRenderId = renderedIdFor(srcNode);
                        const tgtRenderId = renderedIdFor(tgtNode);
                        const activeKey = srcRenderId && tgtRenderId ? getLinkKey(srcRenderId, tgtRenderId) : '';
                        const srcSubmap = fileToSubmap.get(srcNode);
                        const tgtSubmap = fileToSubmap.get(tgtNode);

                        if (srcSubmap === ORPHAN_SENTINEL && activeView !== rootCluster.label) {
                            suppressNextInitialFitRef.current = true;
                            loadDomain(true);
                            activeView = rootCluster.label;
                            activeClusterId = rootCluster.id;
                            await waitForEngineStop(1800);
                            if (!stillActive()) break;
                            pinCurrentNodes();
                        } else if (srcSubmap && srcSubmap !== ORPHAN_SENTINEL && activeView !== srcSubmap) {
                            await goToSubmap(srcSubmap);
                            if (!stillActive()) break;
                        }

                        if (!animatedInternalNodes.has(srcNode)) {
                            await animateNodeInternals(srcNode, undefined, segDur);
                            animatedInternalNodes.add(srcNode);
                            if (!stillActive()) break;
                        }

                        if (
                            srcSubmap &&
                            tgtSubmap &&
                            srcSubmap !== ORPHAN_SENTINEL &&
                            tgtSubmap !== ORPHAN_SENTINEL &&
                            srcSubmap !== tgtSubmap
                        ) {
                            await animateDomainHop(srcSubmap, tgtSubmap);
                            if (!stillActive()) break;
                            await goToSubmap(tgtSubmap);
                            if (!stillActive()) break;
                            continue;
                        }

                        if (!srcRenderId || !tgtRenderId) continue;

                        const fileEdgeExists = linksRef.current.some(l => {
                            const src = getEndpointId(l.source);
                            const tgt = getEndpointId(l.target);
                            return getLinkKey(src, tgt) === activeKey;
                        });
                        if (!fileEdgeExists) {
                            linksRef.current.push({ source: srcRenderId, target: tgtRenderId });
                            tempLinkKeys.add(activeKey);
                        }

                        nodesRef.current.forEach(n => {
                            n.isHighlighted = n.id === srcRenderId || n.id === tgtRenderId;
                            n.isFaded = n.id !== srcRenderId && n.id !== tgtRenderId;
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
                                l.animDur = segDur;
                                l.animForward = src === srcRenderId;
                            }
                        });
                        const cameraDur = focusNodes([srcRenderId, tgtRenderId], 1.02, Math.min(650, segDur));
                        forceCanvasRender();
                        await sleep(Math.max(segDur, cameraDur + 50));
                    }

                    const finalNode = path[path.length - 1];
                    if (finalNode && !animatedInternalNodes.has(finalNode)) {
                        const finalSubmap = fileToSubmap.get(finalNode);
                        if (finalSubmap === ORPHAN_SENTINEL && activeView !== rootCluster.label) {
                            suppressNextInitialFitRef.current = true;
                            loadDomain(true);
                            activeView = rootCluster.label;
                            activeClusterId = rootCluster.id;
                            await waitForEngineStop(1800);
                        } else if (finalSubmap && finalSubmap !== ORPHAN_SENTINEL && activeView !== finalSubmap) {
                            await goToSubmap(finalSubmap);
                        }
                        if (stillActive()) await animateNodeInternals(finalNode, undefined, segDur);
                        animatedInternalNodes.add(finalNode);
                    }
                }

                // Brief pause between segments so transitions are readable.
                if (segIdx < segments.length - 1 && stillActive()) {
                    nodesRef.current.forEach(n => {
                        n.isHighlighted = false;
                        n.isFaded = false;
                    });
                    linksRef.current.forEach(l => {
                        l.isAnimated = false;
                        l.isActiveEdge = false;
                        l.isFaded = false;
                        l.animStart = undefined;
                        l.animForward = undefined;
                        l.animDur = undefined;
                    });
                    forceCanvasRender();
                    await sleep(600); // slightly longer — give canvas one full render cycle to clear
                }
            }

            await sleep(800);
        } finally {
            cleanup();
        }
    }, [
        forceCanvasRender,
        clearFitTimeout,
        focusNodes,
        clusters,
        clusterStack,
        currentCluster,
        loadDomain,
        loadClusterByLabel,
        pinCurrentNodes,
        rootCluster,
        updateActiveInternalIds,
        updateExpandedNodeId,
        updateInternalNodes,
        updateInternalParticle,
        unpinCurrentNodes,
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
        if (n.type === 'cluster' && isCluster(n.treeNode)) loadChildCluster(n.treeNode);
        else if (graphRef.current) {
            const { x, y } = graphRef.current.graph2ScreenCoords(n.x ?? 0, n.y ?? 0);
            setPopup(prev => prev?.node.id === n.id ? null : { node: n, sx: x, sy: y });
        }
    }, [loadChildCluster]);

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
    }, []);

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
                    {canGoBack && (
                        <motion.button key="back"
                                       initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }}
                                       onClick={loadParentLayer}
                                       className="flex items-center gap-1.5 text-[#433b33] hover:text-[#221d18] text-sm font-medium"
                        >
                            <ArrowLeft className="h-4 w-4" /> Up one layer
                        </motion.button>
                    )}
                </AnimatePresence>
                <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-[#433b33] font-bold text-lg">
                            {repoName ?? rootCluster?.label ?? 'Codebase Map'}
                        </span>
                        <span className="shrink-0 rounded-full border border-[#B0A695] bg-[#DDD4C7] px-2 py-0.5 text-[11px] font-semibold text-[#433b33]">
                            {totalFileCount} files
                        </span>
                    </div>
                </div>
                {breadcrumb.length > 1 && (
                    <><span className="text-[#776B5D]">/</span>
                        <span className="text-[#433b33] font-semibold capitalize">{breadcrumb.slice(1).join(' / ')}</span></>
                )}
                <span className="text-xs text-[#776B5D]">{currentLayerCount} visible / {currentLeafCount} files</span>
                <div className="ml-auto flex items-center gap-3">
                    {isPlaying && (
                        <span className="text-xs text-[#2F5D8C] animate-pulse font-semibold">
                            Simulating workflow...
                        </span>
                    )}
                    <button
                        type="button"
                        onClick={() => setShowHelp((value) => !value)}
                        className="flex items-center gap-1.5 rounded-full border border-[#B0A695] bg-[#F3EEEA] px-3 py-1.5 text-xs font-semibold text-[#433b33] shadow-[2px_2px_0_#000] transition hover:-translate-y-0.5"
                    >
                        <HelpCircle className="h-4 w-4" />
                        Help
                    </button>
                </div>
            </div>

            <AnimatePresence>
                {showHelp && (
                    <motion.div
                        initial={{ opacity: 0, y: -8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -8 }}
                        className="absolute right-5 top-[4.6rem] z-30 w-[22rem] rounded-lg border-[2px] border-[#B0A695] bg-[#F8F3EC] p-4 text-[#433b33] shadow-[6px_6px_0_#000]"
                        onMouseDown={(event) => event.stopPropagation()}
                    >
                        <button
                            type="button"
                            className="absolute right-3 top-3 text-[#776B5D] hover:text-[#433b33]"
                            onClick={() => setShowHelp(false)}
                            aria-label="Close help"
                        >
                            <X className="h-4 w-4" />
                        </button>
                        <p className="pr-6 text-sm font-bold">How to use this map</p>
                        <div className="mt-3 space-y-3 text-sm leading-6 text-[#776B5D]">
                            <p>
                                <span className="font-semibold text-[#433b33]">RAG question:</span> searches indexed repo chunks and answers with cited source files.
                            </p>
                            <p>
                                <span className="font-semibold text-[#433b33]">Workflow showcase:</span> turns process questions into graph animation across clusters, files, and internal components.
                            </p>
                            <p>
                                Click folders to go deeper. Use <span className="font-semibold text-[#433b33]">Up one layer</span> or Escape to return.
                            </p>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Canvas area */}
            <div className="absolute inset-0 pt-16">

                {/* TEAMMATE: floating back pill with file count */}
                <AnimatePresence>
                    {canGoBack && (
                        <motion.button
                            initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }}
                            onClick={loadParentLayer}
                            className="absolute left-5 top-20 z-20 flex items-center gap-2 rounded-full border border-[#B0A695] bg-[#DDD4C7] px-4 py-2 text-sm font-medium text-[#433b33] shadow-[3px_3px_0px_0px_rgba(0,0,0,0.8)] transition hover:-translate-y-0.5 hover:text-[#221d18]"
                        >
                            <ArrowLeft className="h-4 w-4" />
                            Parent layer
                            <span className="text-xs text-[#776B5D]">{currentLayerCount} visible</span>
                        </motion.button>
                    )}
                </AnimatePresence>

                <ForceGraph2D
                    ref={graphRef}
                    graphData={graphState}
                    width={dims.w} height={dims.h}
                    backgroundColor={C.bg}
                    autoPauseRedraw={false}
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
                    nodeVal={(n: any) => n.id === expandedNodeId ? 120 : (n.type === 'cluster' ? 70 : 35)}
                    nodePointerAreaPaint={(n: any, color, ctx) => {
                        const isExpanded = n.id === expandedNodeId && n.type === 'file';
                        const w = isExpanded ? 280 : (n.type === 'cluster' ? 220 : 160);
                        const h = isExpanded ? 300 : (n.type === 'cluster' ? 120 : 48);
                        ctx.fillStyle = color;
                        ctx.fillRect((n.x ?? 0) - w / 2, (n.y ?? 0) - h / 2, w, h);
                    }}
                    enableNodeDrag={!isPlaying}
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
                    warmupTicks={150}
                    cooldownTicks={50}
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

            {/* ChatPanel uses global RAG and cross-map workflow by default. */}
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
