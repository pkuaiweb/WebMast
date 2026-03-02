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
const DEFAULT_MODEL_ID = "Phi-3.5-mini-instruct-q4f16_1-MLC"//"Qwen3-1.7B-q4f16_1-MLC" //"Llama-3.2-1B-Instruct-q4f16_1-MLC"// "Llama-3.2-3B-Instruct-q4f32_1-MLC";
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
        isEngineInitializing = false;
        resolve({ status: "error", modelId, error: chrome.runtime.lastError.message });
      } else if (response?.status === "ready") {
        // 同步更新本地状态（应对 background 重启后 offscreen 已就绪的场景）
        offscreenEngineReady = true;
        engineInitProgress = 1;
        isEngineInitializing = false;
        currentModelId = modelId;
        resolve({ status: "ready", modelId });
      } else if (response?.status === "initializing") {
        resolve({ status: "initializing", modelId });
      } else if (response?.status === "error") {
        console.error("[Background] Init engine returned error:", response.error);
        isEngineInitializing = false;
        resolve({ status: "error", modelId, error: response.error || "Unknown engine error" });
      } else {
        isEngineInitializing = false;
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

// ==================== 标签页内容收集 ====================

// 从所有标签页收集内容（由 background 直接调用，无需经过 sidebar 中转）
async function fetchAllTabContents(): Promise<TabContentInfo[]> {
  const tabs = await chrome.tabs.query({ lastFocusedWindow: true });
  if (tabs.length === 0) {
    console.warn("[Background] No tabs found");
    return [];
  }

  const results: TabContentInfo[] = [];

  const promises = tabs.map(async (tab) => {
    if (!tab.id) return;
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: "GET_PAGE_CONTENT" });
      if (response?.contents) {
        const tabUrl = tab.url || "Unknown URL";
        const cachedSummary = await getCachedSummary(tabUrl);

        results.push({
          title: tab.title || "Untitled",
          url: tabUrl,
          content: response.contents,
          cachedSummary: cachedSummary?.summary,
          hasCachedSummary: !!cachedSummary
        });

        console.log(`[Background] Tab loaded: ${tab.title}, hasSummary: ${!!cachedSummary}`);
      }
    } catch (error) {
      // 无法连接的标签页（如 chrome:// 页面），静默跳过
      console.warn(`[Background] Failed to get content from tab ${tab.id} (${tab.url}):`, error);
    }
  });

  await Promise.all(promises);
  return results;
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

// 解析摘要响应 - 三种情况：
// 1. sufficient:yes + answer -> 摘要足够，直接使用答案
// 2. sufficient:no          -> 摘要相关但信息不足，回退到原始内容
// 3. sufficient:yes + N/A   -> 摘要与问题无关，标记为不相关（跳过原始内容）
function parseSummaryResponse(response: string): { sufficient: boolean; answer: string } {
  console.log("[Background] Parsing summary response:", response);
  const normalized = response.toLowerCase();
  
  // 检查 SUFFICIENT 字段
  const sufficientMatch = normalized.match(/\*{0,2}sufficient\*{0,2}:\s*(yes|no)/i);
  const isSufficient = sufficientMatch ? sufficientMatch[1].toLowerCase() === "yes" : false;

  // sufficient:no -> 相关但不足，回退原始内容，无需 ANSWER（优先判断，避免被 answerMatch 缺失误拦截）
  if (sufficientMatch && !isSufficient) {
    return { sufficient: false, answer: "" };
  }

  // 提取 ANSWER 字段
  const answerMatch = response.match(/\*{0,2}answer\*{0,2}:\s*([\s\S]*)/i);  

  if (!sufficientMatch || !answerMatch) {
    // 模型未遵循格式，将整个响应作为答案
    return { sufficient: true, answer: response.trim() };
  }
    let answer = answerMatch[1].trim();
    // 去除多余的星号（模型可能忽略格式要求）
    answer = answer.replace(/^\*+|\*+$/g, "").trim();
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
      content: [
        "You are extracting information from ONE web page that is part of a multi-tab browsing session.",
        "The user's question may span multiple tabs. Your job is to extract ANY relevant partial information from THIS page's content.",
        "",
        "CRITICAL: You may ONLY extract data that is EXPLICITLY written in the CONTENT. Do NOT infer, guess, or use your own knowledge. If a fact is not literally present in the text, do NOT include it.",
        "",
        "Rules:",
        "- Extract ONLY concrete data points that appear VERBATIM in the content.",
        "- ALWAYS include exact numbers in your extraction — these are critical.",
        "- Even a single relevant data point counts as relevant — extract it.",
        "- Do NOT say N/A just because the page alone cannot fully answer the question.",
        "- NEVER guess or infer information based on the product/page type.",
        "- NEVER output negative statements like 'No X found' or 'Not mentioned'.",
        "- If the content does not EXPLICITLY contain data answering the question, respond with EXACTLY: N/A",
        "- Your output must be EITHER concrete bullet points quoting real data from the content, OR the single token N/A. Nothing else."
      ].join("\n")
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
          content: [
            "You are evaluating whether a page summary contains enough information to answer a question.",
            "",
            "CRITICAL RULES:",
            "1. Identify ALL constraints or conditions stated in the question (comparisons, thresholds, superlatives, categories, etc.).",
            "2. A constraint is met ONLY when the summary provides an explicit value that satisfies it. Never assume a constraint is met if the relevant data is missing or ambiguous.",
            "3. In your ANSWER, always state the key facts you extracted so downstream reasoning can double-check them.",
            "",
            "You MUST follow one of these three response formats exactly (no markdown, no asterisks, no extra text):",
            "",
            "Case 1 – Summary is sufficient to answer the question:",
            "SUFFICIENT: yes",
            "ANSWER: <concise answer with the key facts extracted from the summary>",
            "",
            "Case 2 – Summary is relevant to the question but lacks enough detail to verify all constraints:",
            "SUFFICIENT: no",
            "",
            "Case 3 – Summary is completely unrelated to the question:",
            "SUFFICIENT: yes",
            "ANSWER: N/A"
          ].join("\n")
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
          isRelevant = compressedContent.trim().toLowerCase() !== "n/a" &&
                       compressedContent.trim() !== "";
        } else {
          // 摘要不够，使用原始内容
          
          compressedContent = await answerFromContent(tabInfo.content, userMessage);
          console.log(`[Background] Insufficient for: ${tabInfo.title}, answerFromContent: ${compressedContent}`);
          isRelevant = compressedContent.trim().toLowerCase() !== "n/a";
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
        isRelevant = compressedContent.trim().toLowerCase() !== "n/a";
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
        console.log("[Background] Summary saved:", pageData.title, response.summary);
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

    default:
      return false;
  }
});

// ==================== Streaming 辅助函数 ====================

// 确保引擎就绪，失败时通过 port 通知 sidebar 并返回 false
async function ensureEngineReadyForPort(port: chrome.runtime.Port): Promise<boolean> {
  if (!offscreenEngineReady) {
    port.postMessage({ type: "status", status: "initializing", progress: engineInitProgress });
    const result = await initializeEngine();
    if (result.status === "error") {
      port.postMessage({ type: "error", error: result.error || "Engine initialization failed" });
      return false;
    }
  }
  if (!offscreenEngineReady) {
    port.postMessage({ type: "error", error: "Engine not ready" });
    return false;
  }
  return true;
}

async function startStreaming(port: chrome.runtime.Port, messages: any[]): Promise<void> {
  if (!await ensureEngineReadyForPort(port)) return;

  const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  // 注册端口用于接收 streaming 响应
  streamPorts.set(requestId, port);

  // 发送请求到 offscreen
  chrome.runtime.sendMessage({
    type: "CHAT_COMPLETION_STREAM",
    data: {
      requestId,
      messages: messages
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

// ==================== Port 连接（用于 Streaming Chat）====================

chrome.runtime.onConnect.addListener((port) => {
  console.log("[Background] Port connected:", port.name);

  if (port.name === "chat_stream") {
    // Streaming chat 连接
    port.onMessage.addListener(async (message) => {
      if (message.type === "CHAT_STREAM_START") {
        // 直接 streaming：sidebar 已构建好 messages
        await startStreaming(port, message.messages);
      } else if (message.type === "PROCESS_AND_STREAM") {
        // 合并请求：background 自行收集标签页内容 + 处理多标签页 + streaming
        try {
          if (!await ensureEngineReadyForPort(port)) return;

          const { userMessage, useContext } = message;

          // Background 自行收集标签页内容
          let tabContents: TabContentInfo[] = [];
          if (useContext) {
            tabContents = await fetchAllTabContents();
            console.log(`[Background] Fetched ${tabContents.length} tabs`);
          }

          const queryResult = await processMultiTabQuery(tabContents, userMessage);

          if (!queryResult.success || !queryResult.finalMessages) {
            port.postMessage({ type: "error", error: queryResult.error || "Failed to process query" });
            return;
          }

          // 直接将处理结果发送 streaming，中间结果不经由 sidebar
          await startStreaming(port, queryResult.finalMessages);
        } catch (err) {
          port.postMessage({ type: "error", error: String(err) });
        }
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
    console.log("[Background] Offscreen document ready, checking engine status...");
    
    // 先查询 offscreen 当前状态（应对 background 重启但 offscreen 仍运行的场景）
    chrome.runtime.sendMessage({ type: "CHECK_ENGINE_STATUS" }, (statusResponse) => {
      if (!chrome.runtime.lastError && statusResponse?.ready && statusResponse?.modelId === currentModelId) {
        // offscreen 引擎已就绪，直接同步状态，无需重新加载
        offscreenEngineReady = true;
        engineInitProgress = 1;
        isEngineInitializing = false;
        console.log("[Background] Engine already ready in offscreen, state recovered.");
        processSummarizationQueue();
      } else {
        // offscreen 引擎未就绪，正常初始化
        initializeEngine().then(result => {
          console.log("[Background] Initial engine load result:", result.status);
        });
      }
    });
  });
});
