"use client";

import { useEffect, useRef, useState, WheelEvent } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import { queryRepo, queryWorkflow, type QuerySource, type WorkflowFlow } from './adapter';
import { ChatInput } from './ChatInput';

interface ScopeInfo {
  id?: string;
  label: string;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources: QuerySource[];
  confidence: string | null;
  scopeLabel: string;
  pending?: boolean;
  kind?: "message" | "scope_change" | "workflow";
}

interface ChatPanelProps {
  repoId: string;
  scope: ScopeInfo;
  isAnimating?: boolean;
  onQuerySubmitted?: (query: string) => void;
  onWorkflowResponse?: (flow: WorkflowFlow) => void;
}

type ChatMode = "rag" | "workflow";

function isValidWorkflowFlow(flow: WorkflowFlow | undefined): flow is WorkflowFlow {
  const hasCrossNodePath = Array.isArray(flow?.paths) && flow.paths.some((path) => Array.isArray(path) && path.length > 1);
  const hasInternalPath = Array.isArray(flow?.internal_flow?.steps) && flow.internal_flow.steps.length > 0;
  return Boolean(hasCrossNodePath || hasInternalPath);
}

export function ChatPanel({ repoId, scope, isAnimating = false, onQuerySubmitted, onWorkflowResponse }: ChatPanelProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isPanelOpen, setIsPanelOpen] = useState(true);
  const [mode, setMode] = useState<ChatMode>("rag");
  const messageListRef = useRef<HTMLDivElement>(null);
  const previousScopeKeyRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const isMountedRef = useRef(true);
  const scopeKey = `${scope.id ?? 'root'}:${scope.label}`;
  const hasMessages = messages.length > 0;

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    setMessages([]);
    setIsLoading(false);
    setIsPanelOpen(true);
    previousScopeKeyRef.current = null;
    abortRef.current?.abort();
  }, [repoId]);

  useEffect(() => {
    const list = messageListRef.current;
    if (!list) return;
    list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (isAnimating) {
      setIsPanelOpen(false);
    }
  }, [isAnimating]);

  useEffect(() => {
    if (previousScopeKeyRef.current === null) {
      previousScopeKeyRef.current = scopeKey;
      return;
    }

    if (previousScopeKeyRef.current === scopeKey) {
      return;
    }

    previousScopeKeyRef.current = scopeKey;
    setMessages((prev) => {
      if (prev.length === 0) return prev;
      return [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: `__scope_change__:${scope.label}`,
          sources: [],
          confidence: null,
          scopeLabel: scope.label,
          kind: "scope_change",
        },
      ];
    });
  }, [scope.label, scopeKey]);

  const handleQuery = async (query: string) => {
    if (isLoading) return;

    const scopeLabel = scope.label;
    const modeLabel = mode === "workflow" ? "Cross-map Workflow" : "Global RAG";
    const requestScopeLabel = `${modeLabel} - viewing ${scopeLabel}`;

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: query,
      sources: [],
      confidence: null,
      scopeLabel: requestScopeLabel,
      kind: "message",
    };
    const pendingMessage: Message = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
      sources: [],
      confidence: null,
      scopeLabel: requestScopeLabel,
      pending: true,
      kind: "message",
    };

    setIsPanelOpen(true);
    setMessages((prev) => [...prev, userMessage, pendingMessage]);
    setIsLoading(true);
    onQuerySubmitted?.(query);
    abortRef.current?.abort();
    abortRef.current = new AbortController();

    try {
      const queryFn = mode === "workflow" ? queryWorkflow : queryRepo;
      const result = await queryFn(repoId, query, undefined, {
        signal: abortRef.current.signal,
        timeoutMs: mode === "workflow" ? 60000 : 30000,
      });
      if (!isMountedRef.current) return;

      const workflowFlow = isValidWorkflowFlow(result.flow) ? result.flow : undefined;
      const isWorkflow = mode === "workflow" && result.type === "workflow_animation" && Boolean(workflowFlow);
      const responseKind: Message["kind"] = isWorkflow ? "workflow" : "message";
      if (isWorkflow && workflowFlow && onWorkflowResponse) {
        onWorkflowResponse(workflowFlow);
      }

      setMessages((prev) => {
        let found = false;
        const next = prev.map((message) => {
          if (message.id !== pendingMessage.id) return message;
          found = true;
          return {
            ...message,
            content: result.answer || "No answer returned.",
            sources: result.sources,
            confidence: result.confidence,
            pending: false,
            kind: responseKind,
          };
        });

        if (found) return next;

        return [
          ...next,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: result.answer || "No answer returned.",
            sources: result.sources,
            confidence: result.confidence,
            scopeLabel: requestScopeLabel,
            pending: false,
            kind: responseKind,
          },
        ];
      });
    } catch (error) {
      if (!isMountedRef.current) return;

      const content = error instanceof Error ? error.message : "Request failed. Try again.";
      setMessages((prev) => {
        let found = false;
        const next = prev.map((message) => {
          if (message.id !== pendingMessage.id) return message;
          found = true;
          return {
            ...message,
            content,
            pending: false,
          };
        });

        if (found) return next;

        return [
          ...next,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content,
            sources: [],
            confidence: "low",
            scopeLabel: requestScopeLabel,
            pending: false,
            kind: "message",
          },
        ];
      });
    } finally {
      if (isMountedRef.current) {
        setIsLoading(false);
      }
    }
  };

  const stopWheelPropagation = (event: WheelEvent<HTMLDivElement>) => event.stopPropagation();

  const normalizeSourcePath = (filePath: unknown) => {
    if (typeof filePath !== "string" || !filePath) {
      return "Unknown source";
    }
    const markdownLinkMatch = filePath.match(/^\[(.+?)\]\((.+?)\)$/);
    return markdownLinkMatch ? markdownLinkMatch[1] : filePath;
  };

  return (
    <div
      className="pointer-events-none absolute inset-0 z-20"
      onWheel={stopWheelPropagation}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <AnimatePresence>
        {hasMessages && isPanelOpen && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            className="pointer-events-auto absolute bottom-32 right-6 flex max-h-80 w-[min(420px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border-2 border-[#B0A695] bg-[#F3EEEA]/95 p-3 shadow-[6px_6px_0_0_rgba(0,0,0,0.85)] backdrop-blur-sm"
          >
            <div className="mb-2 flex shrink-0 items-center justify-between border-b border-[#B0A695]/60 pb-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-[#776B5D]">
                Responses
              </span>
              <button
                type="button"
                onClick={() => setIsPanelOpen(false)}
                className="rounded-full p-1 text-[#776B5D] transition hover:bg-[#DDD4C7] hover:text-[#433b33]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div ref={messageListRef} className="min-h-0 overflow-y-auto pr-1">
              <div className="flex flex-col gap-2">
              {messages.map((message) => {
                if (message.kind === "scope_change" && message.content.startsWith("__scope_change__:")) {
                  const nextScopeLabel = message.content.replace("__scope_change__:", "");
                  return (
                    <div key={message.id} className="flex items-center gap-3 py-1">
                      <div className="h-px flex-1 bg-[#B0A695]" />
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-[#776B5D]">
                        {nextScopeLabel}
                      </span>
                      <div className="h-px flex-1 bg-[#B0A695]" />
                    </div>
                  );
                }

                const isUser = message.role === "user";
                const bubbleClass = isUser
                  ? "ml-auto bg-[#433b33] text-[#F3EEEA] border-[#221d18]"
                  : "mr-auto bg-[#EBE3D5] text-[#433b33] border-[#B0A695]";

                return (
                  <div key={message.id} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[90%] rounded-2xl border px-3 py-2 shadow-[4px_4px_0_0_rgba(0,0,0,0.65)] ${bubbleClass}`}>
                      <div className={`mb-1 text-[10px] font-semibold uppercase tracking-wide ${isUser ? 'text-[#F3EEEA]/75' : 'text-[#776B5D]'}`}>
                        {message.scopeLabel}
                        {!isUser && message.confidence && !message.pending && (
                          <span className="ml-2 text-[#776B5D]">{message.confidence}</span>
                        )}
                      </div>
                      <p className={`whitespace-pre-wrap break-words text-sm leading-relaxed ${message.pending && !message.content ? 'animate-pulse' : ''}`}>
                        {message.pending && !message.content ? 'Thinking...' : (message.content || 'No answer returned.')}
                      </p>
                      {message.kind === "workflow" && !message.pending && (
                        <span className="mt-1 block text-[10px] font-semibold text-[#2F5D8C]">
                          Animation triggered on graph
                        </span>
                      )}
                      {!message.pending && message.sources.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {message.sources.map((source) => (
                            <span
                              key={`${message.id}-${source.chunk_id}`}
                              className="rounded-full border border-[#B0A695] bg-[#F3EEEA] px-2 py-0.5 text-[10px] font-mono text-[#776B5D]"
                              title={source.summary}
                            >
                              {normalizeSourcePath(source.file_path)}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="pointer-events-auto absolute bottom-6 left-1/2 w-full max-w-xl -translate-x-1/2 px-4">
        {hasMessages && !isPanelOpen && (
          <button
            type="button"
            onClick={() => setIsPanelOpen(true)}
            className="absolute -top-8 right-4 rounded-full border border-[#B0A695] bg-[#DDD4C7] px-3 py-1 text-xs font-medium text-[#433b33] shadow-[3px_3px_0_0_rgba(0,0,0,0.75)] transition hover:-translate-y-0.5"
          >
            Show responses
          </button>
        )}
        <div
          className="mb-2 inline-flex rounded-xl border-2 border-[#B0A695] bg-[#EBE3D5] p-1 shadow-[4px_4px_0_#000]"
          onMouseDown={(event) => event.stopPropagation()}
        >
          {(["rag", "workflow"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setMode(value)}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold uppercase tracking-wide transition ${
                mode === value
                  ? "bg-[#2F5D8C] text-[#F3EEEA]"
                  : "text-[#776B5D] hover:bg-[#D7E3EA] hover:text-[#2F5D8C]"
              }`}
            >
              {value === "rag" ? "RAG" : "Workflow"}
            </button>
          ))}
        </div>
        <ChatInput
          onSubmit={handleQuery}
          scopeLabel={mode === "workflow" ? "Cross-map workflow" : "Global RAG"}
          isLoading={isLoading}
          placeholder={mode === "workflow" ? "Describe a flow to animate..." : "Ask about this codebase..."}
        />
      </div>
    </div>
  );
}
