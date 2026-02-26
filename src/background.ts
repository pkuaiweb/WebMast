"use strict";

/**
 * Background Service Worker - 控制平面
 * 
 * 职责：
 * - 接收 popup / content 的请求
 * - 权限校验、路由、配额、任务队列
 * - 创建/唤醒 offscreen document
 * - 管理会话（session）、取消（abort）、超时、重试
 */

console.log("[Background] Service worker starting...");

// ==================== 类型定义 ====================

interface PendingPageData {
  url: string;
  title: string;
  content: string;
  timestamp: number;
}

interface SummaryData {
  url: string;
  title: string;
  summary: string;
  timestamp: number;
  contentLength: number;
}

interface StreamChunk {
  requestId: string;
  chunk?: string;
  done?: boolean;
  error?: string;
  usage?: any;
}

interface EngineInitResult {
  status: "ready" | "initializing" | "error" ;
  modelId: string;
  error?: string;
}

// ==================== 常量配置 ====================

const SUMMARY_CACHE_PREFIX = "page_summary_";
const PENDING_CACHE_PREFIX = "pending_page_";
const DEFAULT_MODEL_ID = "Qwen3-1.7B-q4f16_1-MLC" //"Llama-3.2-1B-Instruct-q4f16_1-MLC"// "Llama-3.2-3B-Instruct-q4f32_1-MLC";
const MODEL_STORAGE_KEY = "selected_model_id";

let currentModelId = DEFAULT_MODEL_ID;

// Load model ID from storage
async function loadModelIdFromStorage(): Promise<string> {
  const result = await chrome.storage.local.get(MODEL_STORAGE_KEY);
  return (result[MODEL_STORAGE_KEY] as string) || DEFAULT_MODEL_ID;
}

async function saveModelIdToStorage(modelId: string): Promise<void> {
  await chrome.storage.local.set({ [MODEL_STORAGE_KEY]: modelId });
}

console.log("[Background] Default MODEL_ID:", DEFAULT_MODEL_ID);
// 配额和限制
const CONFIG = {
  maxConcurrentRequests: 1,
  requestTimeout: 120000, // 2分钟超时
  maxRetries: 3,
  maxContentLength: 8000,
  minContentLength: 100,
};

// ==================== 状态管理 ====================

let offscreenDocumentCreated = false;
let offscreenEngineReady = false;
let engineInitProgress = 0;
let isEngineInitializing = false;  // 防止重复初始化

// 摘要队列
const summarizationQueue: string[] = [];
let isSummarizing = false;

// Streaming 端口管理
const streamPorts = new Map<string, chrome.runtime.Port>();

// ==================== Offscreen Document 管理 ====================

async function ensureOffscreenDocument(): Promise<boolean> {
  if (offscreenDocumentCreated) {
    return true;
  }

  try {
    // 检查是否已存在
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT]
    });

    if (existingContexts.length > 0) {
      offscreenDocumentCreated = true;
      console.log("[Background] Offscreen document already exists");
      return true;
    }

    // 创建新的 offscreen document
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: "Run WebGPU ML engine for LLM inference"
    });

    offscreenDocumentCreated = true;
    console.log("[Background] Offscreen document created");
    return true;

  } catch (err) {
    console.error("[Background] Failed to create offscreen document:", err);
    return false;
  }
}

async function initializeEngine(forceModelId?: string): Promise<EngineInitResult> {
  const modelId = forceModelId || currentModelId;
  
  if (offscreenEngineReady && !forceModelId) {
    return { status: "ready", modelId };
  }

  // 如果已经在初始化相同的模型，直接返回
  if (isEngineInitializing && !forceModelId) {
    console.log("[Background] Engine already initializing, skipping duplicate request");
    return { status: "initializing", modelId };
  }

  const created = await ensureOffscreenDocument();
  if (!created) {
    return { status: "error", modelId, error: "Failed to create offscreen document" };
  }

  isEngineInitializing = true;
  console.log("[Background] Initializing engine with model:", modelId);

  // 发送初始化请求到 offscreen
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({
      type: "INIT_ENGINE",
      data: { modelId: modelId }
    }, (response) => {
      if (chrome.runtime.lastError) {
        console.error("[Background] Init engine error:", chrome.runtime.lastError);
        resolve({ status: "error", modelId, error: chrome.runtime.lastError.message });
      } else if (response?.status === "ready") {
        resolve({ status: "ready", modelId });
      } else if (response?.status === "initializing") {
        resolve({ status: "initializing", modelId });
      } else if (response?.status === "error") {
        console.error("[Background] Init engine returned error:", response.error);
        resolve({ status: "error", modelId, error: response.error || "Unknown engine error" });
      } else {
        resolve({ status: "error", modelId, error: "Unknown response from offscreen" });
      }
    });
  });
}

// ==================== 摘要缓存管理 ====================

async function getCachedSummary(url: string): Promise<SummaryData | null> {
  const cacheKey = SUMMARY_CACHE_PREFIX + url;
  const cached = await chrome.storage.local.get(cacheKey);
  return (cached[cacheKey] as SummaryData) || null;
}

async function saveCachedSummary(data: SummaryData): Promise<void> {
  const cacheKey = SUMMARY_CACHE_PREFIX + data.url;
  await chrome.storage.local.set({ [cacheKey]: data });
}

async function getAllCachedSummaries(): Promise<{ [url: string]: SummaryData }> {
  const allData = await chrome.storage.local.get(null);
  const summaries: { [url: string]: SummaryData } = {};
  
  for (const key of Object.keys(allData)) {
    if (key.startsWith(SUMMARY_CACHE_PREFIX)) {
      const url = key.replace(SUMMARY_CACHE_PREFIX, "");
      summaries[url] = allData[key] as SummaryData;
    }
  }
  
  return summaries;
}

async function getPendingPage(url: string): Promise<PendingPageData | null> {
  const cacheKey = PENDING_CACHE_PREFIX + url;
  const cached = await chrome.storage.local.get(cacheKey);
  return (cached[cacheKey] as PendingPageData) || null;
}

async function savePendingPage(data: PendingPageData): Promise<void> {
  const cacheKey = PENDING_CACHE_PREFIX + data.url;
  await chrome.storage.local.set({ [cacheKey]: data });
}

async function removePendingPage(url: string): Promise<void> {
  const cacheKey = PENDING_CACHE_PREFIX + url;
  await chrome.storage.local.remove(cacheKey);
}

// ==================== 多标签页处理逻辑 ====================

interface TabContentInfo {
  title: string;
  url: string;
  content: string;
  cachedSummary?: string;
  hasCachedSummary: boolean;
}

interface MultiTabQueryResult {
  success: boolean;
  finalMessages?: Array<{ role: string; content: string }>;
  error?: string;
}

// 解析摘要响应 - 处理各种格式变体
function parseSummaryResponse(response: string): { sufficient: boolean; answer: string } {
  console.log("[Background] Parsing summary response:", response);
  const normalized = response.toLowerCase();
  
  // 检查 SUFFICIENT - 支持多种格式
  const sufficientMatch = normalized.match(/\*{0,2}sufficient\*{0,2}:\s*(yes|no)/i);
  const hasSufficient = sufficientMatch !== null;
  const isSufficient = sufficientMatch ? sufficientMatch[1] === "yes" : false;
  
  // 提取 ANSWER
  const answerMatch = response.match(/\*{0,2}answer\*{0,2}:\s*([\s\S]*)/i);
  let answer = "";
  
  if (answerMatch) {
    answer = answerMatch[1].trim();
    answer = answer.replace(/^\*+|\*+$/g, "").trim();
  } else if (!hasSufficient) {
    answer = response.trim();
    return { sufficient: true, answer };
  }
  
  return { sufficient: isSufficient, answer };
}

// 调用 offscreen 进行静默 chat（中间处理，不更新 UI）
async function silentChat(messages: Array<{ role: string; content: string }>): Promise<string> {
  return new Promise((resolve, reject) => {
    const requestId = `silent_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    chrome.runtime.sendMessage({
      type: "CHAT_COMPLETION",
      data: { requestId, messages }
    }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response?.success) {
        resolve(response.content || "");
      } else {
        reject(new Error(response?.error || "Unknown error"));
      }
    });
  });
}

// 从内容中回答问题
async function answerFromContent(content: string, question: string): Promise<string> {
  const messages = [
    {
      role: "system",
      content: "Answer the question based on the provided content. Format: Concise bullet points. If the content doesn't contain relevant information, say 'No relevant information'. No conversational filler."
    },
    {
      role: "user",
      content: `CONTENT: ${content.substring(0, CONFIG.maxContentLength)}\nQUESTION: ${question}\nANSWER:`
    }
  ];
  
  return silentChat(messages);
}

// 处理多标签页查询 - 核心逻辑
async function processMultiTabQuery(
  allTabContents: TabContentInfo[],
  userMessage: string
): Promise<MultiTabQueryResult> {
  
  if (allTabContents.length <= 1) {
    // 单个标签页或无标签页，使用简单逻辑
    const pageContext = allTabContents
      .map((tabInfo, index) =>
        `=== Tab ${index + 1}: ${tabInfo.title} ===\nURL: ${tabInfo.url}\n\n${tabInfo.content}\n\n`
      )
      .join("\n");

    return {
      success: true,
      finalMessages: [
        {
          role: "system",
          content: `You are a helpful assistant. Here is the content of the browser tab:\n\n${pageContext}\n\nPlease answer questions about this webpage.`
        },
        { role: "user", content: userMessage }
      ]
    };
  }

  console.log(`[Background] Processing ${allTabContents.length} tabs...`);

  // Phase 1: 对每个标签页，使用摘要或原始内容回答问题
  const compressedTabContents: { 
    title: string; 
    url: string; 
    compressed: string; 
    isRelevant: boolean 
  }[] = [];

  for (let i = 0; i < allTabContents.length; i++) {
    const tabInfo = allTabContents[i];
    console.log(`[Background] Processing tab ${i + 1}/${allTabContents.length}: ${tabInfo.title}`);

    let compressedContent = "";
    let isRelevant = true;

    if (tabInfo.hasCachedSummary && tabInfo.cachedSummary) {
      // 使用缓存的摘要
      console.log(`[Background] Using cached summary for: ${tabInfo.title}`);
      
      const summaryMessages = [
        {
          role: "system",
          content: "Answer the question based on the summary. You MUST use this EXACT format (no markdown, no asterisks):\nSUFFICIENT: yes\nANSWER: your answer\n\nOR if info not found:\nSUFFICIENT: no\nANSWER: N/A\n\nBe concise. No extra text."
        },
        {
          role: "user",
          content: `SUMMARY: ${tabInfo.cachedSummary}\n\nQUESTION: ${userMessage}`
        }
      ];

      try {
        const summaryResponse = await silentChat(summaryMessages);
        const parsedResult = parseSummaryResponse(summaryResponse);
        
        if (parsedResult.sufficient) {
          compressedContent = parsedResult.answer;
          isRelevant = !compressedContent.toLowerCase().includes("no relevant information") &&
                       compressedContent.toLowerCase() !== "n/a" &&
                       compressedContent.trim() !== "";
        } else {
          // 摘要不够，使用原始内容
          compressedContent = await answerFromContent(tabInfo.content, userMessage);
          isRelevant = !compressedContent.toLowerCase().includes("no relevant information");
        }
      } catch (err) {
        console.error(`[Background] Error processing tab ${tabInfo.title}:`, err);
        compressedContent = "Error processing this tab";
        isRelevant = false;
      }
    } else {
      // 无缓存摘要，直接使用原始内容
      console.log(`[Background] No cached summary for: ${tabInfo.title}`);
      try {
        compressedContent = await answerFromContent(tabInfo.content, userMessage);
        isRelevant = !compressedContent.toLowerCase().includes("no relevant information");
      } catch (err) {
        console.error(`[Background] Error processing tab ${tabInfo.title}:`, err);
        compressedContent = "Error processing this tab";
        isRelevant = false;
      }
    }

    compressedTabContents.push({
      title: tabInfo.title,
      url: tabInfo.url,
      compressed: compressedContent,
      isRelevant: isRelevant
    });
  }

  // Phase 2: 过滤相关标签页并组合
  const relevantTabs = compressedTabContents.filter(tab => tab.isRelevant);
  console.log(`[Background] Found ${relevantTabs.length} relevant tabs`);

  const combinedContext = relevantTabs
    .map((tabInfo, index) =>
      `=== Tab ${index + 1}: ${tabInfo.title} ===\nURL: ${tabInfo.url}\nRelevant Information: ${tabInfo.compressed}\n`
    )
    .join("\n");

  return {
    success: true,
    finalMessages: [
      {
        role: "system",
        content: relevantTabs.length > 0
          ? `You are a helpful assistant. The user has ${allTabContents.length} browser tabs open. Below is the relevant information extracted from ${relevantTabs.length} relevant tabs:\n\n${combinedContext}\n\nPlease provide a comprehensive answer.`
          : `You are a helpful assistant. The user has ${allTabContents.length} browser tabs open, but none contain relevant information. Please let the user know.`
      },
      { role: "user", content: userMessage }
    ]
  };
}

// ==================== 摘要队列处理 ====================

async function processSummarizationQueue() {
  if (isSummarizing || summarizationQueue.length === 0 || !offscreenEngineReady) {
    return;
  }

  isSummarizing = true;

  while (summarizationQueue.length > 0) {
    const url = summarizationQueue.shift()!;
    const pageData = await getPendingPage(url);

    if (!pageData) {
      continue;
    }

    // 检查是否已有摘要
    const existingSummary = await getCachedSummary(url);
    if (existingSummary) {
      await removePendingPage(url);
      continue;
    }

    console.log("[Background] Summarizing:", pageData.title);

    try {
      const response = await new Promise<any>((resolve) => {
        chrome.runtime.sendMessage({
          type: "SUMMARIZE_PAGE",
          data: {
            url: pageData.url,
            title: pageData.title,
            content: pageData.content.substring(0, CONFIG.maxContentLength)
          }
        }, resolve);
      });

      if (response?.summary) {
        await saveCachedSummary({
          url: pageData.url,
          title: pageData.title,
          summary: response.summary,
          timestamp: Date.now(),
          contentLength: pageData.content.length
        });
        await removePendingPage(url);
        console.log("[Background] Summary saved:", pageData.title);
      } else if (response?.error) {
        console.error("[Background] Summarization error for", pageData.title, ":", response.error);
        // 清理 pending 数据，避免残留
        await removePendingPage(url);
      } else {
        console.warn("[Background] Summarization returned unexpected response for", pageData.title, ":", response);
        await removePendingPage(url);
      }
    } catch (err) {
      console.error("[Background] Summarization failed:", err);
      // Promise reject 场景（如 chrome.runtime.lastError），也清理 pending
      await removePendingPage(url);
    }
  }

  isSummarizing = false;
}

async function queuePageForSummarization(url: string, title: string, content: string) {
  // 检查是否已有摘要
  const existingSummary = await getCachedSummary(url);
  if (existingSummary) {
    console.log("[Background] Summary already exists:", url);
    return;
  }

  // 保存待处理页面
  await savePendingPage({
    url,
    title,
    content,
    timestamp: Date.now()
  });

  // 加入队列
  if (!summarizationQueue.includes(url)) {
    summarizationQueue.push(url);
  }

  // 确保 offscreen 已创建并开始处理
  await ensureOffscreenDocument();
  processSummarizationQueue();
}

// ==================== 消息监听器 ====================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[Background] Received:", message.type);

  switch (message.type) {
    // ==================== Offscreen 引擎状态 ====================
    case "ENGINE_READY":
      offscreenEngineReady = true;
      engineInitProgress = 1;
      isEngineInitializing = false;
      console.log("[Background] Engine ready!");
      processSummarizationQueue();
      sendResponse({ status: "acknowledged" });
      return true;

    case "ENGINE_INIT_PROGRESS":
      engineInitProgress = message.data.progress;
      // console.log("[Background] Engine progress:", Math.round(engineInitProgress * 100) + "%");
      sendResponse({ status: "acknowledged" });
      return true;

    case "ENGINE_ERROR":
      console.error("[Background] Engine error:", message.data.error);
      isEngineInitializing = false;
      sendResponse({ status: "acknowledged" });
      return true;

    // ==================== Streaming 响应（来自 offscreen）====================
    case "STREAM_CHUNK": {
      const chunk = message.data as StreamChunk;
      const port = streamPorts.get(chunk.requestId);
      if (port) {
        port.postMessage({ type: "chunk", data: chunk });
        if (chunk.done || chunk.error) {
          streamPorts.delete(chunk.requestId);
        }
      }
      sendResponse({ status: "acknowledged" });
      return true;
    }

    // ==================== Popup 请求 ====================
    case "GET_ENGINE_STATUS":
      sendResponse({
        ready: offscreenEngineReady,
        progress: engineInitProgress,
        modelId: currentModelId
      });
      return true;

    case "CHANGE_MODEL": {
      const newModelId = message.data?.modelId;
      if (!newModelId) {
        sendResponse({ success: false, error: "No model ID provided" });
        return true;
      }
      
      if (newModelId === currentModelId && offscreenEngineReady) {
        sendResponse({ success: true, status: "same_model" });
        return true;
      }
      
      // Save to storage and reinitialize
      currentModelId = newModelId;
      offscreenEngineReady = false;
      engineInitProgress = 0;
      isEngineInitializing = true;  // Set IMMEDIATELY to prevent race with INIT_ENGINE_REQUEST
      
      // Save to storage (fire and forget)
      saveModelIdToStorage(newModelId).catch(err => 
        console.error("[Background] Failed to save model ID:", err)
      );
      
      // 立即返回响应，让 popup 可以开始轮询进度
      sendResponse({ success: true, status: "loading", modelId: newModelId });
      
      // 异步初始化引擎（不等待完成）
      initializeEngine(newModelId).catch(err => 
        console.error("[Background] Engine init failed:", err)
      );
      return true;
    }

    case "GET_SAVED_MODEL_ID":
      loadModelIdFromStorage().then(modelId => {
        sendResponse({ modelId });
      });
      return true;

    case "INIT_ENGINE_REQUEST":
      initializeEngine().then((result) => {
        sendResponse({ status: result.status, modelId: result.modelId, error: result.error });
      });
      return true;

    // ==================== 页面内容处理 ====================
    case "PAGE_LOADED": {
      const { url, title, content } = message.data;
      console.log("[Background] PAGE_LOADED:", title, "length:", content?.length);
      
      if (content && content.length > CONFIG.minContentLength) {
        queuePageForSummarization(url, title, content).then(() => {
          sendResponse({ status: "queued" });
        });
      } else {
        sendResponse({ status: "skipped", reason: "content too short" });
      }
      return true;
    }

    // ==================== 缓存查询 ====================
    case "GET_CACHED_SUMMARY":
      getCachedSummary(message.data.url).then(summary => {
        sendResponse({ summary });
      });
      return true;

    case "GET_ALL_CACHED_SUMMARIES":
      getAllCachedSummaries().then(summaries => {
        sendResponse({ summaries });
      });
      return true;

    // ==================== 多标签页处理 ====================
    case "PROCESS_MULTI_TAB_QUERY": {
      const { tabContents, userMessage } = message.data;
      
      // 确保引擎就绪
      if (!offscreenEngineReady) {
        sendResponse({ success: false, error: "Engine not ready" });
        return true;
      }
      
      processMultiTabQuery(tabContents, userMessage)
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ success: false, error: String(err) }));
      return true;
    }

    default:
      return false;
  }
});

// ==================== Port 连接（用于 Streaming Chat）====================

chrome.runtime.onConnect.addListener((port) => {
  console.log("[Background] Port connected:", port.name);

  if (port.name === "chat_stream") {
    // Streaming chat 连接
    port.onMessage.addListener(async (message) => {
      if (message.type === "CHAT_STREAM_START") {
        const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // 确保引擎就绪
        if (!offscreenEngineReady) {
          port.postMessage({ type: "status", status: "initializing", progress: engineInitProgress });
          const result = await initializeEngine();
          if (result.status === "error") {
            port.postMessage({ type: "error", error: result.error || "Engine initialization failed" });
            return;
          }
        }

        if (!offscreenEngineReady) {
          port.postMessage({ type: "error", error: "Engine not ready" });
          return;
        }

        // 注册端口用于接收 streaming 响应
        streamPorts.set(requestId, port);

        // 发送请求到 offscreen
        chrome.runtime.sendMessage({
          type: "CHAT_COMPLETION_STREAM",
          data: {
            requestId,
            messages: message.messages
          }
        }, (response) => {
          if (chrome.runtime.lastError) {
            port.postMessage({ type: "error", error: chrome.runtime.lastError.message });
            streamPorts.delete(requestId);
          } else if (response?.error) {
            console.error("[Background] Stream start error:", response.error);
            port.postMessage({ type: "error", error: response.error });
            streamPorts.delete(requestId);
          }
        });
      }
    });

    port.onDisconnect.addListener(() => {
      console.log("[Background] Stream port disconnected");
      // 清理该端口关联的所有请求
      for (const [requestId, p] of streamPorts.entries()) {
        if (p === port) {
          streamPorts.delete(requestId);
          // 可以发送取消请求到 offscreen
          chrome.runtime.sendMessage({
            type: "ABORT_REQUEST",
            data: { requestId }
          });
        }
      }
    });
  }
});

// ==================== 初始化 ====================

// 设置点击扩展图标时打开侧边栏
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// 启动时加载保存的模型 ID 并创建 offscreen document，然后开始初始化引擎
loadModelIdFromStorage().then(savedModelId => {
  currentModelId = savedModelId;
  console.log("[Background] Loaded model ID from storage:", currentModelId);
  
  ensureOffscreenDocument().then(() => {
    console.log("[Background] Offscreen document ready, starting engine initialization...");
    // 启动时就开始加载模型，不等 popup 触发
    initializeEngine().then(result => {
      console.log("[Background] Initial engine load result:", result.status);
    });
  });
});
