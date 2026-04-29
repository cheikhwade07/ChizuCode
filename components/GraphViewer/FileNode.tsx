"use client";

import { Handle, Position } from '@xyflow/react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils';
import { FileCode2, X } from 'lucide-react';
import { useState } from 'react';

export function FileNode({ data }: any) {
  const isHighlighted: boolean = data.isHighlighted;
  const isFaded: boolean = data.isFaded;
  const [popupOpen, setPopupOpen] = useState(false);

  return (
    <>
      <div
        className={cn(
          "relative rounded-xl border bg-[#E8DFCA] backdrop-blur-sm",
          "min-w-[200px] px-4 py-3 cursor-pointer",
          "transition-all duration-500",
          isHighlighted
            ? "border-blue-700 shadow-[0_0_24px_rgba(6,182,212,0.7)]"
            : "border-black-700 hover:border-black-500",
          isFaded ? "opacity-25 grayscale pointer-events-none" : "opacity-100"
        )}
        onClick={() => !isFaded && setPopupOpen((v) => !v)}
      >
        {/* Pulsing aura when highlighted */}
        {isHighlighted && (
          <motion.div
            className="absolute -inset-1 rounded-xl bg-gradient-to-r from-blue-500/60 to-blue-600/60 blur-lg -z-10"
            animate={{ opacity: [0.3, 0.7, 0.3] }}
            transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
          />
        )}

        <Handle
          type="target"
          position={Position.Top}
          className="!bg-slate-600 !w-2 !h-2"
        />

        <div className="flex items-center gap-2.5">
          <div className={cn(
            "rounded-lg p-2 shrink-0 border border-black",
            isHighlighted ? "bg-blue-500/20 text-blue-400" : "bg-[#F5EFE6] text-black-400"
          )}>
            <FileCode2 className="h-4 w-4" />
          </div>
          <span className={cn(
            "text-sm font-semibold truncate",
            isHighlighted ? "text-blue-400" : "text-black-200"
          )}>
            {data.fileName}
          </span>
        </div>

        <Handle
          type="source"
          position={Position.Bottom}
          className="!bg-slate-600 !w-2 !h-2"
        />
      </div>

      {/* Detail popup — rendered outside the node so it's not clipped */}
      <AnimatePresence>
        {popupOpen && (
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.95 }}
            transition={{ duration: 0.2 }}
            className={cn(
              "absolute left-1/2 -translate-x-1/2 top-[calc(100%+12px)]",
              "w-[280px] z-[9999]",
              "rounded-xl border border-slate-600 bg-[#E8DFCA] shadow-2xl backdrop-blur-md p-4"
            )}
            // Stop React Flow from panning when interacting with popup
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              className="absolute top-2 right-2 text-slate-500 hover:text-slate-300 transition-colors"
              onClick={(e) => { e.stopPropagation(); setPopupOpen(false); }}
            >
              <X className="h-4 w-4" />
            </button>

            <p className="text-xs font-semibold text-blue-600 mb-1 uppercase tracking-wide">Directory</p>
            <p className="text-sm text-black-300 font-mono mb-3 break-all">{data.directory}</p>

            <p className="text-xs font-semibold text-blue-600 mb-1 uppercase tracking-wide">Functionality</p>
            <p className="text-sm text-black-300 leading-relaxed">{data.functionality}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
