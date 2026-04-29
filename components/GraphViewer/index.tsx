"use client";

import { useCallback, useEffect, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  useNodesState,
  useEdgesState,
  useReactFlow,
  ReactFlowProvider,
  Node,
  Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, Zap } from 'lucide-react';

import { SubmapNode } from './SubmapNode';
import { FileNode } from './FileNode';
import { AnimatedEdge } from './AnimatedEdge';
import graphData from '@/test.json';

import dagre from "@dagrejs/dagre";

interface FileEntry {
  fileName: string;
  directory: string;
  functionality: string;
  connection: string[];
}

interface Submap {
  name: string;
  files: FileEntry[];
}

const nodeTypes = {
  submap:  SubmapNode,
  file:    FileNode,
};

const edgeTypes = {
  animated: AnimatedEdge,
};

function buildDomainNodes(submaps: Submap[], onClickSubmap: (name: string) => void): Node[] {
  const GAP = 380;
  const startX = (800 - GAP * (submaps.length - 1)) / 2;
  return submaps.map((sm, i) => ({
    id: `submap-${sm.name}`,
    type: 'submap',
    position: { x: startX + i * GAP, y: 180 },
    data: {
      name: sm.name,
      fileCount: sm.files.length,
      onClick: () => onClickSubmap(sm.name),
    },
  }));
}

// -- dagre layout for file nodes
const FILE_NODE_WIDTH = 260;
const FILE_NODE_HEIGHT = 120;

function applyDagreLayout(
  nodes: Node[],
  edges: Edge[],
  direction: "TB" | "LR" = "TB"
): Node[] {
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));

  dagreGraph.setGraph({
    rankdir: direction,
    nodesep: 100,
    ranksep: 120,
  });

  nodes.forEach((node) => {
    dagreGraph.setNode(node.id, {
      width: FILE_NODE_WIDTH,
      height: FILE_NODE_HEIGHT,
    });
  });

  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target);
  });

  dagre.layout(dagreGraph);

  return nodes.map((node) => {
    const pos = dagreGraph.node(node.id);

    return {
      ...node,
      position: {
        x: pos.x - FILE_NODE_WIDTH / 2,
        y: pos.y - FILE_NODE_HEIGHT / 2,
      },
    };
  });
}

function buildSubmapGraph(submap: Submap): { nodes: Node[]; edges: Edge[] } {
  const files = submap.files;
  const fileNames = new Set(files.map((f) => f.fileName));

  const COLS = Math.ceil(Math.sqrt(files.length + 1));
  const H_GAP = 290;
  const V_GAP = 180;

  const nodes: Node[] = files.map((file, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    return {
      id: file.fileName,
      type: 'file',
      position: { x: col * H_GAP, y: row * V_GAP },
      data: {
        fileName: file.fileName,
        directory: file.directory,
        functionality: file.functionality,
        isHighlighted: false,
        isFaded: false,
      },
    };
  });

  const edgeSet = new Set<string>();
  const edges: Edge[] = [];

  for (const file of files) {
    for (const conn of file.connection) {
      if (!fileNames.has(conn)) continue; 
      const edgeKey = [file.fileName, conn].sort().join('--');
      if (edgeSet.has(edgeKey)) continue;
      edgeSet.add(edgeKey);

      edges.push({
        id: `e-${file.fileName}-${conn}`,
        source: file.fileName,
        target: conn,
        type: 'animated',
        data: { isAnimated: false, isFaded: false },
      });
    }
  }

  return { nodes: applyDagreLayout(nodes, edges, "LR"), edges };
}

function GraphViewerInner() {
  const submaps: Submap[] = (graphData as any).submaps;

  const [activeSubmap, setActiveSubmap] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const { fitView } = useReactFlow();

  const loadDomainView = useCallback(() => {
    setActiveSubmap(null);
    setIsPlaying(false);
    const domainNodes = buildDomainNodes(submaps, (name) => loadSubmapView(name));
    setNodes(domainNodes);
    setEdges([]);
    setTimeout(() => fitView({ padding: 0.3, duration: 500 }), 50);
  }, [submaps, fitView]);

  const loadSubmapView = useCallback(
    (name: string) => {
      setIsPlaying(false);
      const sm = submaps.find((s) => s.name === name);
      if (!sm) return;
      const { nodes: fileNodes, edges: fileEdges } = buildSubmapGraph(sm);
      setActiveSubmap(name);
      setNodes(fileNodes);
      setEdges(fileEdges);
      setTimeout(() => fitView({ padding: 0.35, duration: 600 }), 50);
    },
    [submaps, fitView, setNodes, setEdges]
  );

  useEffect(() => {
    loadDomainView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  const simulateLogin = () => {
    if (activeSubmap !== 'login') {
      loadSubmapView('login');
      setTimeout(() => triggerLoginAnimation(), 700);
    } else {
      triggerLoginAnimation();
    }
  };

  const triggerLoginAnimation = () => {
    setIsPlaying(true);

    const activeFileIds   = ['userService.js', 'authController.js'];
    const activeEdgeIds   = ['e-authController.js-userService.js', 'e-userService.js-authController.js'];

    setNodes((nds) =>
      nds.map((n) => ({
        ...n,
        data: {
          ...n.data,
          isHighlighted: activeFileIds.includes(n.id),
          isFaded: !activeFileIds.includes(n.id),
        },
      }))
    );

    setEdges((eds) =>
      eds.map((e) => ({
        ...e,
        data: {
          ...e.data,
          isAnimated: activeEdgeIds.includes(e.id),
          isFaded: !activeEdgeIds.includes(e.id),
        },
      }))
    );

    setTimeout(() => {
      setNodes((nds) =>
        nds.map((n) => ({
          ...n,
          data: { ...n.data, isHighlighted: false, isFaded: false },
        }))
      );
      setEdges((eds) =>
        eds.map((e) => ({
          ...e,
          data: { ...e.data, isAnimated: false, isFaded: false },
        }))
      );
      setIsPlaying(false);
    }, 6000);
  };


  return (
    <div className="w-full h-screen bg-slate-950 relative overflow-hidden">
      {/* Top bar */}
      <div className="absolute top-0 left-0 right-0 z-20 flex items-center gap-3 px-5 py-4 bg-slate-950/80 backdrop-blur border-b border-slate-800">
        {/* Back button */}
        <AnimatePresence>
          {activeSubmap && (
            <motion.button
              key="back"
              initial={{ opacity: 0, x: -12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -12 }}
              transition={{ duration: 0.2 }}
              onClick={loadDomainView}
              className="flex items-center gap-1.5 text-slate-400 hover:text-slate-200 transition-colors text-sm font-medium"
            >
              <ArrowLeft className="h-4 w-4" />
              All domains
            </motion.button>
          )}
        </AnimatePresence>

        {/* Breadcrumb */}
        <div className="flex items-center gap-2">
          <span className="text-slate-100 font-bold text-lg leading-none">Codebase Map</span>
          {activeSubmap && (
            <>
              <span className="text-slate-600">/</span>
              <span className="text-cyan-400 font-semibold capitalize">{activeSubmap}</span>
            </>
          )}
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Simulate button */}
        <motion.button
          whileHover={{ scale: 1.04 }}
          whileTap={{ scale: 0.97 }}
          onClick={simulateLogin}
          disabled={isPlaying}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-700 disabled:cursor-not-allowed text-white text-sm font-semibold shadow-lg transition-colors"
        >
          <Zap className="h-4 w-4" />
          {isPlaying ? 'Simulating login…' : 'Simulate Login Flow'}
        </motion.button>
      </div>

      {/* Canvas */}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        colorMode="dark"
        className="pt-16"
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} color="#1e293b" />
        <Controls className="!bottom-6 !right-6 !left-auto !top-auto" />
      </ReactFlow>

      {/* Hint overlay in domain view */}
      <AnimatePresence>
        {!activeSubmap && (
          <motion.p
            key="hint"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute bottom-6 left-1/2 -translate-x-1/2 text-xs text-slate-500 pointer-events-none"
          >
            Click a domain card to explore its files
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Public export wrapped in provider ───────────────────────────────────────

export function GraphViewer() {
  return (
    <ReactFlowProvider>
      <GraphViewerInner />
    </ReactFlowProvider>
  );
}
