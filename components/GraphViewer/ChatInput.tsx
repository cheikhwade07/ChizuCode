"use client";

import { useEffect, useRef, useState, KeyboardEvent, WheelEvent } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { History, Send } from 'lucide-react';

interface ChatInputProps {
  onSubmit?: (query: string) => void;
}

/** For multi-line queries: show only the last non-empty line in the compact faded view */
function extractDisplayLine(raw: string): string {
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1] : raw.trim();
}

// Fixed pixel height of the faded scrollable zone — the mask stays the same height always
const FADED_ZONE_HEIGHT = 72;

export function ChatInput({ onSubmit }: ChatInputProps) {
  const [inputValue, setInputValue] = useState('');
  const [history, setHistory]       = useState<string[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  const textareaRef    = useRef<HTMLTextAreaElement>(null);
  const fadedScrollRef = useRef<HTMLDivElement>(null);      // the faded scrollable zone
  const historyListRef = useRef<HTMLUListElement>(null);    // the popup list

  // ── Auto-resize textarea ────────────────────────────────────────────────────
  const resizeTextarea = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
  };

  // Resize on every inputValue change (covers programmatic sets from history clicks)
  useEffect(() => { resizeTextarea(); }, [inputValue]);

  // ── Scroll faded zone to bottom whenever a new entry is added ───────────────
  useEffect(() => {
    if (fadedScrollRef.current) {
      fadedScrollRef.current.scrollTo({ top: fadedScrollRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [history.length]);

  // ── Scroll popup list to bottom whenever it opens ──────────────────────────
  useEffect(() => {
    if (showHistory && historyListRef.current) {
      historyListRef.current.scrollTop = historyListRef.current.scrollHeight;
    }
  }, [showHistory, history.length]);

  // ── Submit ──────────────────────────────────────────────────────────────────
  const handleSubmit = () => {
    const trimmed = inputValue.trim();
    if (!trimmed) return;

    setHistory((prev) => [...prev, trimmed]);
    setShowHistory(false);
    setInputValue('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    onSubmit?.(trimmed);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  // Stop wheel events inside the faded zone from panning the React Flow canvas
  const stopWheelPropagation = (e: WheelEvent<HTMLDivElement>) => {
    e.stopPropagation();
  };

  return (
    <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-20 w-full max-w-lg px-4 flex flex-col items-center gap-2">

      {/* ── Faded scrollable history zone ──────────────────────────────────── */}
      <div className="relative w-full">

        {/* The fixed-height container: mask-gradient sits here, height never changes */}
        <div
          ref={fadedScrollRef}
          onWheel={stopWheelPropagation}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => history.length > 0 && setShowHistory((v) => !v)}
          title={history.length > 0 ? 'Scroll to browse · Click for full history' : undefined}
          className="w-full overflow-y-auto"
          style={{
            height: history.length > 0 ? `${FADED_ZONE_HEIGHT}px` : '0px',
            transition: 'height 0.3s ease',
            // Mask: fully transparent at top, opaque at bottom — height is fixed so effect is consistent
            maskImage:
              'linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.2) 30%, rgba(0,0,0,0.65) 60%, black 100%)',
            WebkitMaskImage:
              'linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.2) 30%, rgba(0,0,0,0.65) 60%, black 100%)',
            // Hide the scrollbar visually
            scrollbarWidth: 'none',
            msOverflowStyle: 'none',
            cursor: history.length > 0 ? 'pointer' : 'default',
          }}
        >
          {/* Padding top pushes content toward the bottom so latest sits at the opaque edge */}
          <div className="flex flex-col justify-end min-h-full pt-4 pb-0.5 px-1 gap-1">
            {history.map((q, i) => (
              <motion.p
                key={i}
                initial={i === history.length - 1 ? { opacity: 0, y: 8 } : false}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
                className="text-sm text-slate-200 font-medium leading-snug select-none shrink-0"
              >
                {extractDisplayLine(q)}
              </motion.p>
            ))}
          </div>
        </div>

        {/* History popup — positioned above the faded zone */}
        <AnimatePresence>
          {showHistory && history.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 6, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.97 }}
              transition={{ duration: 0.18 }}
              className="absolute bottom-full mb-2 left-0 right-0 z-30 rounded-xl border border-slate-700 bg-slate-900/95 backdrop-blur-md shadow-2xl overflow-hidden"
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-2 px-4 py-2.5 border-b border-slate-800">
                <History className="h-3.5 w-3.5 text-slate-500" />
                <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
                  Request History
                </span>
              </div>
              {/* Oldest at top, newest at bottom — auto-scrolled to bottom on open */}
              <ul ref={historyListRef} className="max-h-48 overflow-y-auto py-1">
                {history.map((q, i) => (
                  <li key={i}>
                    <button
                      className="w-full text-left px-4 py-2.5 text-sm text-slate-300 hover:bg-slate-800 transition-colors"
                      onClick={() => {
                        setInputValue(q);
                        setShowHistory(false);
                        textareaRef.current?.focus();
                      }}
                    >
                      <span className="text-slate-500 text-xs mr-2 tabular-nums">{i + 1}.</span>
                      {q}
                    </button>
                  </li>
                ))}
              </ul>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ── Text input ─────────────────────────────────────────────────────── */}
      <div
        className="relative w-full flex items-end gap-2 rounded-2xl border border-slate-700 bg-slate-900/90 backdrop-blur-md px-4 py-3 shadow-xl transition-colors focus-within:border-cyan-500/70"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <textarea
          ref={textareaRef}
          id="codebase-chat-input"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onInput={resizeTextarea}
          rows={1}
          placeholder="Ask about this codebase…"
          className="flex-1 bg-transparent text-sm text-slate-200 placeholder-slate-600 resize-none focus:outline-none leading-relaxed overflow-hidden"
          style={{ minHeight: '24px', maxHeight: '128px' }}
        />
        <button
          id="codebase-chat-send"
          onClick={handleSubmit}
          disabled={!inputValue.trim()}
          className="shrink-0 rounded-lg p-2 bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-800 disabled:text-slate-600 disabled:cursor-not-allowed text-white transition-colors"
        >
          <Send className="h-4 w-4" />
        </button>
      </div>

      <p className="text-[10px] text-slate-700 select-none">
        Enter to send · Shift+Enter for new line · scroll or click faded text for history
      </p>
    </div>
  );
}
