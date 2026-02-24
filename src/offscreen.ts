"use strict";

/**
 * Offscreen Document - 推理平面
 * 
 * 职责：
 * - 初始化 WebGPU
 * - 加载模型（权重缓存、分片加载）
 * - 执行推理，支持 streaming token
 * - 维护 KV cache / batch / quant 等优化
 */

import { CreateMLCEngine, MLCEngineInterface, ChatCompletionMessageParam } from "@mlc-ai/web-llm";

console.log("[Offscreen] Offscreen document loaded");

// ==================== 状态管理 ====================

let engine: MLCEngineInterface | null = null;
let isEngineInitializing = false;
let engineReady = false;
let currentModelId = "";

// 请求管理（用于取消）
const activeRequests = new Map<string, { aborted: boolean }>();

// ==================== 引擎初始化 ====================

async function initEngine(modelId: string = "Llama-3.2-1B-Instruct-q4f16_1-MLC") {
  // If same model is already initialized, return ready
  if (engine && currentModelId === modelId && engineReady) {
    console.log("[Offscreen] Engine already initialized with model:", modelId);
    return { status: "ready" };
  }
  
  // If initializing the same model, return initializing status
  if (isEngineInitializing && currentModelId === modelId) {
    console.log("[Offscreen] Engine already initializing with model:", modelId);
    return { status: "initializing" };
  }

  // If a different model is requested, we need to unload the current engine
  if (engine && currentModelId !== modelId) {
    console.log("[Offscreen] Switching model from", currentModelId, "to", modelId);
    
    // Cancel all active requests
    for (const [requestId] of activeRequests) {
      const request = activeRequests.get(requestId);
      if (request) {
        request.aborted = true;
      }
    }
    activeRequests.clear();
    
    // Unload current engine
    try {
      await engine.unload();
      console.log("[Offscreen] Previous engine unloaded");
    } catch (err) {
      console.warn("[Offscreen] Error unloading engine:", err);
    }
    
    engine = null;
    engineReady = false;
  }

  isEngineInitializing = true;
  currentModelId = modelId;
  console.log("[Offscreen] Initializing engine with model:", modelId);

  try {
    engine = await CreateMLCEngine(modelId, {
      initProgressCallback: (report) => {
        const progress = report.progress;
        // report.text 包含阶段信息，例如：
        // "Loading model from cache[1/2]: ..." (加载配置/tokenizer)
        // "Loading model from cache[2/2]: ..." (加载权重)
        // 或 "Fetching param cache[1/x]: ..." (下载时)
        console.log("[Offscreen] Engine init progress:", Math.round(progress * 100) + "%", "-", report.text);
        
        // 通知 background 进度
        chrome.runtime.sendMessage({
          type: "ENGINE_INIT_PROGRESS",
          data: { progress, text: report.text }
        }).catch(() => {});
      }
    });

    engineReady = true;
    console.log("[Offscreen] Engine initialized successfully!");

    // 通知 background 引擎就绪
    chrome.runtime.sendMessage({
      type: "ENGINE_READY",
      data: { modelId }
    }).catch(() => {});

    return { status: "ready" };

  } catch (err) {
    console.error("[Offscreen] Failed to initialize engine:", err);
    
    chrome.runtime.sendMessage({
      type: "ENGINE_ERROR",
      data: { error: String(err) }
    }).catch(() => {});

    return { status: "error", error: String(err) };

  } finally {
    isEngineInitializing = false;
  }
}

// ==================== Chat Completion ====================

async function chatCompletion(
  requestId: string,
  messages: ChatCompletionMessageParam[]
): Promise<{ content: string; usage?: any }> {
  if (!engine || !engineReady) {
    throw new Error("Engine not ready");
  }

  // 注册请求
  activeRequests.set(requestId, { aborted: false });

  try {
    const completion = await engine.chat.completions.create({
      stream: false,
      messages: messages,
    });

    // 检查是否已取消
    if (activeRequests.get(requestId)?.aborted) {
      throw new Error("Request aborted");
    }

    const content = completion.choices[0]?.message?.content || "";
    return { 
      content,
      usage: completion.usage
    };

  } finally {
    activeRequests.delete(requestId);
  }
}

// ==================== 超时工具函数 ====================

const STREAM_TIMEOUT_MS = 60000; // 60秒超时
const CHUNK_TIMEOUT_MS = 30000; // 单个 chunk 超时 30 秒

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => 
      setTimeout(() => reject(new Error(`${operation} timeout after ${timeoutMs}ms`)), timeoutMs)
    )
  ]);
}

// ==================== Streaming Chat Completion ====================

async function chatCompletionStream(
  requestId: string,
  messages: ChatCompletionMessageParam[]
): Promise<void> {
  if (!engine || !engineReady) {
    chrome.runtime.sendMessage({
      type: "STREAM_CHUNK",
      data: { requestId, error: "Engine not ready" }
    });
    return;
  }

  // 注册请求
  activeRequests.set(requestId, { aborted: false });

  try {
    const completion = await withTimeout(
      engine.chat.completions.create({
        stream: true,
        messages: messages,
        stream_options: { include_usage: true },
      }),
      STREAM_TIMEOUT_MS,
      "Chat completion create"
    );

    let usage = null;
    let lastChunkTime = Date.now();

    for await (const chunk of completion) {
      // 检查是否已取消
      if (activeRequests.get(requestId)?.aborted) {
        await engine.interruptGenerate();
        chrome.runtime.sendMessage({
          type: "STREAM_CHUNK",
          data: { requestId, error: "Request aborted", done: true }
        });
        return;
      }

      // 检查 chunk 间隔超时
      const now = Date.now();
      if (now - lastChunkTime > CHUNK_TIMEOUT_MS) {
        await engine.interruptGenerate();
        throw new Error("Stream stalled - no chunk received for " + CHUNK_TIMEOUT_MS + "ms");
      }
      lastChunkTime = now;

      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        // 发送 chunk 到 background
        chrome.runtime.sendMessage({
          type: "STREAM_CHUNK",
          data: { requestId, chunk: delta }
        }).catch(() => {});
      }

      // 获取使用统计（在最后一个 chunk 中）
      if (chunk.usage) {
        usage = chunk.usage;
      }
    }

    // 发送完成信号
    chrome.runtime.sendMessage({
      type: "STREAM_CHUNK",
      data: { requestId, done: true, usage }
    }).catch(() => {});

  } catch (err) {
    console.error("[Offscreen] Stream error:", err);
    chrome.runtime.sendMessage({
      type: "STREAM_CHUNK",
      data: { requestId, error: String(err), done: true }
    }).catch(() => {});

  } finally {
    activeRequests.delete(requestId);
  }
}

// ==================== 页面摘要 ====================

async function summarizePage(
  url: string,
  title: string,
  content: string
): Promise<{ summary: string }> {
  if (!engine || !engineReady) {
    throw new Error("Engine not ready");
  }

  console.log("[Offscreen] Summarizing page:", title);

  const requestId = `summarize_${Date.now()}`;
  activeRequests.set(requestId, { aborted: false });

  const messages: ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: "You are a helpful assistant that summarizes web pages. Create a concise summary with key points (5-10 bullet points). Focus on: main topics, key facts, important details, and actionable information. Be brief but comprehensive."
    },
    {
      role: "user",
      content: `Summarize this webpage:\n\nTitle: ${title}\n\nContent:\n${content}`
    }
  ];

  try {
    let summary = "";
    const completion = await withTimeout(
      engine.chat.completions.create({
        stream: true,
        messages: messages,
      }),
      STREAM_TIMEOUT_MS,
      "Summarize completion create"
    );

    let lastChunkTime = Date.now();

    for await (const chunk of completion) {
      // 检查是否已取消
      if (activeRequests.get(requestId)?.aborted) {
        await engine.interruptGenerate();
        throw new Error("Request aborted");
      }

      // 检查 chunk 间隔超时
      const now = Date.now();
      if (now - lastChunkTime > CHUNK_TIMEOUT_MS) {
        await engine.interruptGenerate();
        throw new Error("Stream stalled - no chunk received for " + CHUNK_TIMEOUT_MS + "ms");
      }
      lastChunkTime = now;

      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        summary += delta;
      }
    }

    console.log("[Offscreen] Summary generated:", summary.length, "chars");
    return { summary };

  } finally {
    activeRequests.delete(requestId);
  }
}

// ==================== 请求取消 ====================

function abortRequest(requestId: string) {
  const request = activeRequests.get(requestId);
  if (request) {
    request.aborted = true;
    console.log("[Offscreen] Request aborted:", requestId);
  }
}

// ==================== 重置引擎 ====================

async function resetEngine() {
  if (engine) {
    // 取消所有活跃请求
    for (const [requestId] of activeRequests) {
      abortRequest(requestId);
    }
    activeRequests.clear();

    // 重置聊天
    await engine.resetChat();
    console.log("[Offscreen] Engine chat reset");
  }
}

// ==================== 消息监听器 ====================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[Offscreen] Received message:", message.type);

  switch (message.type) {
    case "INIT_ENGINE":
      initEngine(message.data?.modelId).then(sendResponse);
      return true;

    case "CHAT_COMPLETION":
      chatCompletion(message.data.requestId, message.data.messages)
        .then(result => sendResponse({ success: true, ...result }))
        .catch(err => sendResponse({ success: false, error: String(err) }));
      return true;

    case "CHAT_COMPLETION_STREAM":
      chatCompletionStream(message.data.requestId, message.data.messages)
        .then(() => sendResponse({ status: "streaming" }))
        .catch(err => sendResponse({ error: String(err) }));
      return true;

    case "SUMMARIZE_PAGE":
      const { url, title, content } = message.data;
      summarizePage(url, title, content)
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ error: String(err) }));
      return true;

    case "ABORT_REQUEST":
      abortRequest(message.data.requestId);
      sendResponse({ status: "aborted" });
      return true;

    case "RESET_CHAT":
      resetEngine()
        .then(() => sendResponse({ status: "reset" }))
        .catch(err => sendResponse({ error: String(err) }));
      return true;

    case "CHECK_ENGINE_STATUS":
      sendResponse({
        ready: engineReady,
        initializing: isEngineInitializing,
        modelId: currentModelId
      });
      return true;

    case "GET_RUNTIME_STATS":
      // Note: runtimeStatsText() is deprecated. Use ChatCompletion.usage or
      // ChatCompletionChunk.usage (with stream_options: { include_usage: true }) instead.
      sendResponse({ stats: null, deprecated: true });
      return true;

    default:
      return false;
  }
});

// ==================== 注意 ====================
// 不要在这里自动调用 initEngine()
// 引擎初始化由 background service worker 通过 INIT_ENGINE 消息触发
// 这样可以确保使用 background 中配置的 MODEL_ID
