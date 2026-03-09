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
// const activeRequests = new Map<string, { aborted: boolean }>();

// ==================== 抗复读配置 ====================

/**
 * 强力抗复读
 * repetition_penalty 会惩罚整个上下文（含 prompt）中出现过的 token，
 * 仅在长文本流式生成时使用。
 */
const ANTI_REPEAT_CONFIG = {
  repetition_penalty: 1.15,   // >1.0 降低已生成 token 的概率
  frequency_penalty: 0.5,     // 按词频累加惩罚
  presence_penalty: 0.5,      // 只要出现过就施加惩罚
  temperature: 0.8,           // 略高随机性，避免贪心解码陷入循环
  top_p: 0.9,
};

/**
 * 温和参数
 * 不设 repetition_penalty，避免模型无法复述页面中的关键词而返回 N/A。
 * 仅用轻度 frequency_penalty 防止极端循环。
 */
const MILD_REPEAT_CONFIG = {
  frequency_penalty: 0.15,
  presence_penalty: 0.1,
  temperature: 0.6,
  top_p: 0.9,
};

/**
 * 流式复读检测器
 * 检测连续 n-gram 重复，若最近窗口内重复率过高则报告复读。
 */
class RepetitionDetector {
  private buffer = "";
  private readonly windowSize: number;    // 检测窗口（字符数）
  private readonly ngramLen: number;      // n-gram 长度
  private readonly threshold: number;     // 重复率阈值

  constructor(windowSize = 300, ngramLen = 20, threshold = 0.4) {
    this.windowSize = windowSize;
    this.ngramLen = ngramLen;
    this.threshold = threshold;
  }

  feed(text: string): void {
    this.buffer += text;
  }

  /** 返回 true 表示检测到严重复读 */
  isRepeating(): boolean {
    if (this.buffer.length < this.windowSize) return false;
    const window = this.buffer.slice(-this.windowSize);
    const ngrams = new Map<string, number>();
    let total = 0;
    let repeated = 0;
    for (let i = 0; i <= window.length - this.ngramLen; i++) {
      const gram = window.substring(i, i + this.ngramLen);
      const count = ngrams.get(gram) || 0;
      ngrams.set(gram, count + 1);
      total++;
      if (count > 0) repeated++;
    }
    return total > 0 && repeated / total > this.threshold;
  }

  reset(): void {
    this.buffer = "";
  }
}

// ==================== 引擎初始化 ====================

async function initEngine(modelId: string) {
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
        }).catch(() => { });
      }
    });

    engineReady = true;
    console.log("[Offscreen] Engine initialized successfully!");

    // 通知 background 引擎就绪
    chrome.runtime.sendMessage({
      type: "ENGINE_READY",
      data: { modelId }
    }).catch(() => { });

    return { status: "ready" };

  } catch (err) {
    console.error("[Offscreen] Failed to initialize engine:", err);

    chrome.runtime.sendMessage({
      type: "ENGINE_ERROR",
      data: { error: String(err) }
    }).catch(() => { });

    return { status: "error", error: String(err) };

  } finally {
    isEngineInitializing = false;
  }
}

// ==================== Chat Completion ====================

// ==================== 超时配置 ====================

const STREAM_TIMEOUT_MS = 30000; // 60秒超时

// ==================== 通用生成内核 ====================

interface GenerateCallbacks {
  /** 每产出一段 delta 文本时调用 */
  onChunk: (delta: string) => void;
  /** 生成正常完成时调用 */
  onDone: (usage: any) => void;
  /** 请求被取消时调用 */
  onAbort: () => void;
}

/**
 * 统一的流式生成内核。
 * 负责：超时 (Promise.race)、abort 检测、复读检测、KV cache 清理。
 * chatCompletion / chatCompletionStream 都委托给它。
 */
async function generateCore(
  requestId: string,
  messages: ChatCompletionMessageParam[],
  callbacks: GenerateCallbacks,
  extraCreateParams: Record<string, any> = {},
): Promise<{ content: string; usage?: any }> {
  if (!engine || !engineReady) {
    throw new Error("Engine not ready");
  }

  // activeRequests.set(requestId, { aborted: false });

  let content = "";
  let usage: any = null;
  const completion = await engine!.chat.completions.create({
    stream: true,
    messages,
    stream_options: { include_usage: true },
    ...extraCreateParams,
  });

  // const detector = new RepetitionDetector();

  for await (const chunk of completion) {

    const delta = chunk.choices[0]?.delta?.content;
    if (delta) {
      content += delta;
      // detector.feed(delta);
      callbacks.onChunk(delta);
    }

    if (chunk.usage) {
      usage = chunk.usage;
    }
  }
  // activeRequests.delete(requestId);
  callbacks.onDone(usage);

  return { content, usage };
}

// ==================== Chat Completion （非流式封装） ====================

/**
 * 非流式 chat —— 内部流式生成 + 复读检测，完成后一次性返回结果。
 */
async function chatCompletion(
  requestId: string,
  messages: ChatCompletionMessageParam[]
): Promise<{ content: string; usage?: any }> {
  return generateCore(requestId, messages, {
    onChunk: () => { },                       // 不需要逐 chunk 处理
    onDone: () => { },                        // 由返回值传递结果
    onAbort: () => { },                       // 由 throw 传递错误
  }, MILD_REPEAT_CONFIG);
}

// ==================== Streaming Chat Completion （流式封装） ====================

/**
 * 流式 chat —— 每个 token 实时推送到 background。
 */
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

  try {
    await generateCore(requestId, messages, {
      onChunk: (delta) => {
        chrome.runtime.sendMessage({
          type: "STREAM_CHUNK",
          data: { requestId, chunk: delta }
        }).catch(() => { });
      },
      onDone: (usage) => {
        chrome.runtime.sendMessage({
          type: "STREAM_CHUNK",
          data: { requestId, done: true, usage }
        }).catch(() => { });
      },
      onAbort: () => {
        chrome.runtime.sendMessage({
          type: "STREAM_CHUNK",
          data: { requestId, error: "Request aborted", done: true }
        }).catch(() => { });
      },
    });
  } catch (err) {
    console.warn("[Offscreen] Stream error:", err);
    chrome.runtime.sendMessage({
      type: "STREAM_CHUNK",
      data: { requestId, error: String(err), done: true }
    }).catch(() => { });
  }
}

// ==================== 请求取消 ====================


// ==================== 重置引擎 ====================

async function resetEngine() {
  if (engine) {
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
      if (!message.data?.modelId) {
        sendResponse({ status: "error", error: "modelId is required" });
        return true;
      }
      initEngine(message.data.modelId).then(sendResponse);
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

    case "ABORT_REQUEST":
      // abortRequest(message.data.requestId);
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
