"use client";

import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { FolderOpen, ChevronRight } from 'lucide-react';

const SUBMAP_COLORS: Record<string, { border: string; glow: string; icon: string; badge: string }> = {
  login:   { border: 'border-cyan-500',   glow: 'shadow-[0_0_40px_rgba(6,182,212,0.35)]',   icon: 'text-cyan-400',   badge: 'bg-cyan-500/20 text-cyan-300' },
  payment: { border: 'border-violet-500', glow: 'shadow-[0_0_40px_rgba(139,92,246,0.35)]', icon: 'text-violet-400', badge: 'bg-violet-500/20 text-violet-300' },
};

const DEFAULT_COLOR = { border: 'border-slate-600', glow: '', icon: 'text-slate-400', badge: 'bg-slate-700 text-slate-300' };

export function SubmapNode({ data }: any) {
  const colors = SUBMAP_COLORS[data.name] ?? DEFAULT_COLOR;
  const fileCount: number = data.fileCount ?? 0;

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.85 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.7 }}
      transition={{ duration: 0.35, ease: 'easeOut' }}
      onClick={data.onClick}
      className={cn(
        "relative rounded-2xl border-2 bg-slate-900/90 backdrop-blur-md cursor-pointer",
        "w-[280px] p-6 select-none transition-all duration-300",
        "hover:scale-[1.03] hover:brightness-110",
        colors.border,
        colors.glow
      )}
    >
      {/* Animated ambient glow */}
      <motion.div
        className={cn(
          "absolute -inset-px rounded-2xl opacity-20 blur-xl -z-10",
          data.name === 'login' ? 'bg-cyan-500' : 'bg-violet-500'
        )}
        animate={{ opacity: [0.15, 0.3, 0.15] }}
        transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
      />

      <div className="flex items-start justify-between mb-4">
        <div className={cn("rounded-xl bg-slate-800 p-3", colors.icon)}>
          <FolderOpen className="h-7 w-7" />
        </div>
        <span className={cn("text-xs font-medium px-2 py-1 rounded-full", colors.badge)}>
          {fileCount} files
        </span>
      </div>

      <h2 className="text-xl font-bold text-slate-100 capitalize mb-1">{data.name}</h2>
      <p className="text-sm text-slate-400 mb-4">Click to explore this domain</p>

      <div className={cn("flex items-center gap-1 text-xs font-semibold", colors.icon)}>
        Zoom in <ChevronRight className="h-3 w-3" />
      </div>
    </motion.div>
  );
}
