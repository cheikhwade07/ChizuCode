"use client";

import { KeyboardEvent, useEffect, useRef, useState, WheelEvent } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { History, LoaderCircle, Send } from 'lucide-react';

interface ChatInputProps {
  onSubmit?: (query: string) => void;
  scopeLabel: string;
  isLoading?: boolean;
}

function extractDisplayLine(raw: string): string {
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1] : raw.trim();
}

export function ChatInput({ onSubmit, scopeLabel, isLoading = false }: ChatInputProps) {
  const [inputValue, setInputValue] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const historyListRef = useRef<HTMLUListElement>(null);

  const resizeTextarea = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
  };

  useEffect(() => {
    resizeTextarea();
  }, [inputValue]);

  useEffect(() => {
    if (showHistory && historyListRef.current) {
      historyListRef.current.scrollTop = historyListRef.current.scrollHeight;
    }
  }, [showHistory, history.length]);

  const handleSubmit = () => {
    const trimmed = inputValue.trim();
    if (!trimmed || isLoading) return;

    setHistory((prev) => [...prev, trimmed]);
    setShowHistory(false);
    setInputValue('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    onSubmit?.(trimmed);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSubmit();
    }
  };

  const stopWheelPropagation = (event: WheelEvent<HTMLDivElement>) => event.stopPropagation();

  return (
    <div className="flex w-full flex-col items-end gap-2">
      <div className="relative w-full">
        <AnimatePresence>
          {showHistory && history.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 8, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.97 }}
              transition={{ duration: 0.18 }}
              className="absolute bottom-full right-0 z-30 mb-2 w-full overflow-hidden rounded-xl border-2 border-black bg-[#E8DFCA] shadow-[6px_6px_0_#000]"
              onMouseDown={(event) => event.stopPropagation()}
              onWheel={stopWheelPropagation}
            >
              <div className="flex items-center gap-2 border-b-2 border-black bg-[#F5EFE6] px-4 py-2.5">
                <History className="h-3.5 w-3.5 text-black/50" />
                <span className="text-xs font-semibold uppercase tracking-wide text-black/60">
                  {scopeLabel} History
                </span>
              </div>
              <ul ref={historyListRef} className="py-1">
                {history.slice(-5).map((query, index) => (
                  <li key={`${index}-${query}`}>
                    <button
                      className="w-full px-4 py-2.5 text-left text-sm text-black transition-colors hover:bg-[#F5EFE6]"
                      onClick={() => {
                        setInputValue(query);
                        setShowHistory(false);
                        textareaRef.current?.focus();
                      }}
                    >
                      <span className="mr-2 text-xs font-semibold tabular-nums text-blue-600">
                        {Math.max(history.length - 5, 0) + index + 1}.
                      </span>
                      {extractDisplayLine(query)}
                    </button>
                  </li>
                ))}
              </ul>
            </motion.div>
          )}
        </AnimatePresence>

        <div
          className="relative flex w-full items-end gap-2 rounded-2xl border-2 border-black bg-[#E8DFCA] px-4 py-3 shadow-[6px_6px_0_#000] transition-shadow focus-within:shadow-[6px_6px_0_rgba(29,78,216,0.5)]"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="absolute left-4 top-2 text-[10px] font-medium text-black/50">
            Scope: {scopeLabel}
          </div>
          <textarea
            ref={textareaRef}
            id="codebase-chat-input"
            value={inputValue}
            onChange={(event) => setInputValue(event.target.value)}
            onKeyDown={handleKeyDown}
            onInput={resizeTextarea}
            rows={1}
            placeholder="Ask about this codebase..."
            disabled={isLoading}
            className="mt-4 flex-1 resize-none overflow-hidden bg-transparent text-sm leading-relaxed text-black placeholder-black/40 focus:outline-none disabled:cursor-not-allowed disabled:text-black/45"
            style={{ minHeight: '24px', maxHeight: '128px' }}
          />
          <button
            id="codebase-chat-send"
            onClick={handleSubmit}
            disabled={!inputValue.trim() || isLoading}
            className="shrink-0 rounded-lg bg-cyan-600 p-2 text-white transition-colors hover:bg-cyan-500 disabled:cursor-not-allowed disabled:bg-black/10 disabled:text-black/30"
          >
            {isLoading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={() => history.length > 0 && setShowHistory((value) => !value)}
            disabled={history.length === 0}
            className="shrink-0 rounded-lg p-2 text-black/55 transition hover:bg-black/5 hover:text-black disabled:cursor-not-allowed disabled:text-black/20"
          >
            <History className="h-4 w-4" />
          </button>
        </div>
      </div>

      <p className="select-none text-[10px] text-black/35">
        Enter to send - Shift+Enter for new line
      </p>
    </div>
  );
}
