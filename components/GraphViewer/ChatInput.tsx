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

// Fixed pixel height of the faded scrollable zone — mask stays the same height always
const FADED_ZONE_HEIGHT = 72;

export function ChatInput({ onSubmit }: ChatInputProps) {
  const [inputValue, setInputValue]   = useState('');
  const [history, setHistory]         = useState<string[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  const textareaRef    = useRef<HTMLTextAreaElement>(null);
  const fadedScrollRef = useRef<HTMLDivElement>(null);
  const historyListRef = useRef<HTMLUListElement>(null);

  // ── Auto-resize textarea ───────────────────────────────────────────────────
  const resizeTextarea = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
  };

  useEffect(() => { resizeTextarea(); }, [inputValue]);

  // ── Scroll faded zone to bottom on new entry ───────────────────────────────
  useEffect(() => {
    if (fadedScrollRef.current) {
      fadedScrollRef.current.scrollTo({
        top: fadedScrollRef.current.scrollHeight,
        behavior: 'smooth',
      });
    }
  }, [history.length]);

  // ── Scroll popup list to bottom when opened ────────────────────────────────
  useEffect(() => {
    if (showHistory && historyListRef.current) {
      historyListRef.current.scrollTop = historyListRef.current.scrollHeight;
    }
  }, [showHistory, history.length]);

  // ── Submit ─────────────────────────────────────────────────────────────────
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

  // Stop scrolling inside the faded zone from panning the React Flow canvas
  const stopWheelPropagation = (e: WheelEvent<HTMLDivElement>) => e.stopPropagation();

  return (
    <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-20 w-full max-w-lg px-4 flex flex-col items-center gap-2">

      {/* ── Faded scrollable history zone ──────────────────────────────────── */}
      <div className="relative w-full">

        {/* Fixed-height container: mask-gradient applied here so height (and fade) never shifts */}
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
            // Transparent at top → opaque at bottom; fixed container = consistent fade depth
            maskImage:
              'linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.2) 30%, rgba(0,0,0,0.65) 60%, black 100%)',
            WebkitMaskImage:
              'linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.2) 30%, rgba(0,0,0,0.65) 60%, black 100%)',
            scrollbarWidth: 'none',
            msOverflowStyle: 'none',
            cursor: history.length > 0 ? 'pointer' : 'default',
          }}
        >
          {/* Content stacks at the bottom so the latest entry sits at the opaque edge */}
          <div className="flex flex-col justify-end min-h-full pt-4 pb-0.5 px-1 gap-1">
            {history.map((q, i) => (
              <motion.p
                key={i}
                initial={i === history.length - 1 ? { opacity: 0, y: 8 } : false}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
                // Matches node card text: dark on the warm-cream canvas
                className="text-sm text-black font-medium leading-snug select-none shrink-0"
              >
                {extractDisplayLine(q)}
              </motion.p>
            ))}
          </div>
        </div>

        {/* History popup — same card style as FileNode detail popup */}
        <AnimatePresence>
          {showHistory && history.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 6, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.97 }}
              transition={{ duration: 0.18 }}
              // bg-[#E8DFCA] + border-black + shadow matches SubmapNode / FileNode popup
              className="absolute bottom-full mb-2 left-0 right-0 z-30 rounded-xl border-2 border-black bg-[#E8DFCA] shadow-[6px_6px_0_#000] overflow-hidden"
              onMouseDown={(e) => e.stopPropagation()}
            >
              {/* Header — matches the top-bar bg used in index.tsx */}
              <div className="flex items-center gap-2 px-4 py-2.5 border-b-2 border-black bg-[#F5EFE6]">
                <History className="h-3.5 w-3.5 text-black/50" />
                <span className="text-xs font-semibold text-black/60 uppercase tracking-wide">
                  Request History
                </span>
              </div>
              {/* Oldest at top, newest at bottom — auto-scrolled to bottom on open */}
              <ul ref={historyListRef} className="max-h-48 overflow-y-auto py-1">
                {history.map((q, i) => (
                  <li key={i}>
                    <button
                      // Hover bg matches FileNode icon hover — #F5EFE6 warm cream
                      className="w-full text-left px-4 py-2.5 text-sm text-black hover:bg-[#F5EFE6] transition-colors"
                      onClick={() => {
                        setInputValue(q);
                        setShowHistory(false);
                        textareaRef.current?.focus();
                      }}
                    >
                      {/* Accent number uses blue-600, matching FileNode's label accent */}
                      <span className="text-blue-600 text-xs mr-2 tabular-nums font-semibold">
                        {i + 1}.
                      </span>
                      {q}
                    </button>
                  </li>
                ))}
              </ul>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ── Text input — matches node card style ───────────────────────────── */}
      <div
        // bg-[#E8DFCA] card + border-black + hard shadow = same as SubmapNode/FileNode
        className="relative w-full flex items-end gap-2 rounded-2xl border-2 border-black bg-[#E8DFCA] px-4 py-3 shadow-[6px_6px_0_#000] transition-shadow focus-within:shadow-[6px_6px_0_rgba(29,78,216,0.5)]"
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
          // Text black, placeholder matches muted node sub-text
          className="flex-1 bg-transparent text-sm text-black placeholder-black/40 resize-none focus:outline-none leading-relaxed overflow-hidden"
          style={{ minHeight: '24px', maxHeight: '128px' }}
        />
        {/* Send button: bg-cyan-600 matches the "Simulate Login Flow" button in index.tsx */}
        <button
          id="codebase-chat-send"
          onClick={handleSubmit}
          disabled={!inputValue.trim()}
          className="shrink-0 rounded-lg p-2 bg-cyan-600 hover:bg-cyan-500 disabled:bg-black/10 disabled:text-black/30 disabled:cursor-not-allowed text-white transition-colors"
        >
          <Send className="h-4 w-4" />
        </button>
      </div>

      {/* Hint text — muted, same tone as node sub-labels */}
      <p className="text-[10px] text-black/35 select-none">
        Enter to send · Shift+Enter for new line · scroll or click faded text for history
      </p>
    </div>
  );
}
