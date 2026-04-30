"use client";

import { KeyboardEvent, useEffect, useRef, useState, WheelEvent } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { History, LoaderCircle, Send } from 'lucide-react';

interface ChatInputProps {
  onSubmit?: (query: string) => void;
  scopeLabel: string;
  isLoading?: boolean;
  placeholder?: string;
}

function extractDisplayLine(raw: string): string {
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1] : raw.trim();
}

export function ChatInput({ onSubmit, scopeLabel, isLoading = false, placeholder = "Ask about this codebase..." }: ChatInputProps) {
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
              className="absolute bottom-full right-0 z-30 mb-2 w-full overflow-hidden rounded-xl border-2 border-[#B0A695] bg-[#EBE3D5] shadow-[6px_6px_0_#000]"
              onMouseDown={(event) => event.stopPropagation()}
              onWheel={stopWheelPropagation}
            >
              <div className="flex items-center gap-2 border-b-2 border-[#B0A695] bg-[#F3EEEA] px-4 py-2.5">
                <History className="h-3.5 w-3.5 text-[#776B5D]" />
                <span className="text-xs font-semibold uppercase tracking-wide text-[#776B5D]">
                  {scopeLabel} History
                </span>
              </div>
              <ul ref={historyListRef} className="py-1">
                {history.slice(-5).map((query, index) => (
                  <li key={`${index}-${query}`}>
                    <button
                      className="w-full px-4 py-2.5 text-left text-sm text-[#433b33] transition-colors hover:bg-[#F3EEEA]"
                      onClick={() => {
                        setInputValue(query);
                        setShowHistory(false);
                        textareaRef.current?.focus();
                      }}
                    >
                      <span className="mr-2 text-xs font-semibold tabular-nums text-[#2F5D8C]">
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
          className="relative flex w-full items-end gap-2 rounded-2xl border-2 border-[#B0A695] bg-[#EBE3D5] px-4 py-3 shadow-[6px_6px_0_#000] transition-shadow focus-within:shadow-[6px_6px_0_rgba(67,59,51,0.55)]"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="absolute left-4 top-2 text-[10px] font-medium text-[#776B5D]">
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
            placeholder={placeholder}
            disabled={isLoading}
            className="mt-4 flex-1 resize-none overflow-hidden bg-transparent text-sm leading-relaxed text-[#433b33] placeholder-[#776B5D]/70 focus:outline-none disabled:cursor-not-allowed disabled:text-[#776B5D]/60"
            style={{ minHeight: '24px', maxHeight: '128px' }}
          />
          <button
            id="codebase-chat-send"
            onClick={handleSubmit}
            disabled={!inputValue.trim() || isLoading}
            className="shrink-0 rounded-lg bg-[#2F5D8C] p-2 text-[#F3EEEA] transition-colors hover:bg-[#24496f] disabled:cursor-not-allowed disabled:bg-[#DDD4C7] disabled:text-[#776B5D]"
          >
            {isLoading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={() => history.length > 0 && setShowHistory((value) => !value)}
            disabled={history.length === 0}
            className="shrink-0 rounded-lg p-2 text-[#776B5D] transition hover:bg-[#DDD4C7] hover:text-[#433b33] disabled:cursor-not-allowed disabled:text-[#B0A695]"
          >
            <History className="h-4 w-4" />
          </button>
        </div>
      </div>

      <p className="select-none text-[10px] text-[#776B5D]/70">
        Enter to send - Shift+Enter for new line
      </p>
    </div>
  );
}
