"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, isTextUIPart } from "ai";
import { useRef, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { SendHorizonal, Bot, User } from "lucide-react";

const transport = new DefaultChatTransport({ api: "/api/chat" });

export function ChatInterface() {
  const { messages, sendMessage, status, error } = useChat({ transport });
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const isLoading = status === "submitted" || status === "streaming";

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;
    sendMessage({ role: "user", parts: [{ type: "text", text: trimmed }] });
    setInput("");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      handleSubmit(e as unknown as React.FormEvent);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto space-y-4 pb-4 min-h-0">
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-32 text-zinc-500 text-sm">
            Ask about tasks, PRs, or anything Mainark...
          </div>
        )}

        {messages.map((message) => (
          <div
            key={message.id}
            className={cn(
              "flex gap-3",
              message.role === "user" ? "flex-row-reverse" : "flex-row"
            )}
          >
            <div
              className={cn(
                "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs",
                message.role === "user"
                  ? "bg-blue-600 text-white"
                  : "bg-zinc-700 text-zinc-300"
              )}
            >
              {message.role === "user" ? <User className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
            </div>
            <div
              className={cn(
                "rounded-lg px-3 py-2 max-w-[85%] text-sm leading-relaxed",
                message.role === "user"
                  ? "bg-blue-600 text-white"
                  : "bg-zinc-800 text-zinc-100"
              )}
            >
              {message.parts.filter(isTextUIPart).map((part, i) => (
                <p key={i} className="whitespace-pre-wrap">{part.text}</p>
              ))}
            </div>
          </div>
        ))}

        {isLoading && (
          <div className="flex gap-3">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-700">
              <Bot className="h-3.5 w-3.5 text-zinc-300" />
            </div>
            <div className="rounded-lg px-3 py-2 bg-zinc-800 text-zinc-400 text-sm animate-pulse">
              Thinking...
            </div>
          </div>
        )}

        {error && (
          <p className="text-xs text-red-400 text-center">{error.message}</p>
        )}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={handleSubmit} className="flex gap-2 pt-3 border-t border-zinc-800">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask anything... (Enter to send)"
          rows={1}
          className="flex-1 resize-none rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-blue-500 min-h-[38px] max-h-28"
        />
        <button
          type="submit"
          disabled={isLoading || !input.trim()}
          className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <SendHorizonal className="h-4 w-4" />
        </button>
      </form>
    </div>
  );
}
