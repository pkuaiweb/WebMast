"use strict";

import buildInfo from "./build-info.json";

/**
 * Background Service Worker - 控制平面
 * 
 * 职责：
 * - 接收 popup / content 的请求
 * - 权限校验、路由、配额、任务队列
 * - 创建/唤醒 offscreen document
 * - 管理会话（session）、取消（abort）、超时、重试
 */

console.log(`[Background] Service worker starting... (build: ${buildInfo.uid} @ ${buildInfo.timestamp})`);

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
  status: "ready" | "initializing" | "error";
  modelId: string;
  error?: string;
}

// ==================== 常量配置 ====================

const SUMMARY_CACHE_PREFIX = "page_summary_";
const PENDING_CACHE_PREFIX = "pending_page_";
const DEFAULT_MODEL_ID = "Qwen3-1.7B-q4f16_1-MLC" // "Phi-3.5-mini-instruct-q4f16_1-MLC"// "Llama-3.2-1B-Instruct-q4f16_1-MLC"// "Llama-3.2-3B-Instruct-q4f32_1-MLC";
const MODEL_STORAGE_KEY = "selected_model_id";
const USE_SUMMARY_CACHE = true; // 是否启用摘要缓存
const DATA_FLOW_TYPE: number = 6; // 1: 直接拼接，2: content提取，3: summary提取，4: summary评估+回退，5: 子问题+content，6: 子问题+summary评估+回退
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
let engineReady = false;
let engineInitProgress = 0;
let isEngineInitializing = false;  // 防止重复初始化

// 摘要队列
const summarizationQueue: string[] = [];
let isSummarizing = false;

// Streaming 端口管理
const streamPorts = new Map<string, chrome.runtime.Port>();

// 端口关联的所有活跃请求 ID（silentChat + streaming），用于 disconnect 时统一取消
// const portActiveRequests = new Map<chrome.runtime.Port, Set<string>>();

// silentChat 的 reject 回调，用于 abort 时拒绝 pending promise
const pendingRejects = new Map<string, (reason: Error) => void>();

// 用户提问优先级控制
let userQueryPending = false;
let summarizationYieldedResolve: (() => void) | null = null;
let summarizationResumePromise: Promise<void> | null = null;
let summarizationResumeResolve: (() => void) | null = null;

// Streaming 完成回调（用于等待流式生成结束）
const streamCompletionCallbacks = new Map<string, () => void>();

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

/**
 * 创建/重载引擎（发送 INIT_ENGINE 到 offscreen）。
 * 集中管理引擎相关状态：offscreenEngineReady, engineInitProgress, isEngineInitializing, currentModelId。
 * 调用方只需传入 modelId，状态转换全部在此函数内完成。
 */
async function initializeEngine(modelId?: string): Promise<EngineInitResult> {
  // 如果未传 modelId，使用当前已选模型
  const targetModelId = modelId || currentModelId;

  // 同一模型已就绪，直接返回
  if (engineReady && targetModelId === currentModelId) {
    return { status: "ready", modelId: targetModelId };
  }

  // 同一模型正在初始化中，跳过重复请求
  if (isEngineInitializing && targetModelId === currentModelId) {
    console.log("[Background] Engine already initializing, skipping duplicate request");
    return { status: "initializing", modelId: targetModelId };
  }

  const created = await ensureOffscreenDocument();
  if (!created) {
    return { status: "error", modelId: targetModelId, error: "Failed to create offscreen document" };
  }

  // ---- 集中设置状态 ----
  currentModelId = targetModelId;
  engineReady = false;
  engineInitProgress = 0;
  isEngineInitializing = true;
  console.log("[Background] Initializing engine with model:", targetModelId);

  // 仅发送消息，状态由 ENGINE_READY / ENGINE_ERROR 回调更新
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({
      type: "INIT_ENGINE",
      data: { modelId: targetModelId }
    }, (response) => {
      if (chrome.runtime.lastError) {
        console.error("[Background] Init engine error:", chrome.runtime.lastError);
        resolve({ status: "error", modelId: targetModelId, error: chrome.runtime.lastError.message });
      } else 
        resolve(response);
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
          index: (tab.index ?? -1) + 1,
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
  console.log(results);
  await Promise.all(promises);
  return results;
}

// ==================== 多标签页处理逻辑 ====================

interface TabContentInfo {
  index: number;
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

// 解析摘要响应 - 两种情况：
// 1. sufficient:yes + answer -> 摘要足够，直接使用答案
// 2. sufficient:no          -> 摘要信息不足，回退到原始内容
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

// 如果模型是 Qwen3，在最后一条 user 消息末尾追加 /nothink
function appendNothinkIfQwen3(messages: Array<{ role: string; content: string }>): Array<{ role: string; content: string }> {
  if (!currentModelId.toLowerCase().includes("qwen3")) return messages;
  const result = messages.map(m => ({ ...m }));
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i].role === "user") {
      result[i].content += " /nothink /no_think";
      break;
    }
    // result[i].content="/no_think "+result[i].content+" /no_think";
  }
  return result;
}

// 调用 offscreen 进行静默 chat（中间处理，不更新 UI）
// activeRequests: 可选，传入端口关联的请求集合，用于 disconnect 时取消
async function silentChat(
  messages: Array<{ role: string; content: string }>,
  port: chrome.runtime.Port | null = null,
): Promise<string> {
  messages = appendNothinkIfQwen3(messages);
  return new Promise((resolve, reject) => {
    const requestId = `silent_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // 注册到端口的活跃请求集合
    // activeRequests?.add(requestId);
    // 注册 reject 回调用于取消
    pendingRejects.set(requestId, reject);
    if (port) {
      streamPorts.set(requestId, port);
    }

    chrome.runtime.sendMessage({
      type: "CHAT_COMPLETION",
      data: { requestId, messages }
    }, (response) => {
      pendingRejects.delete(requestId);
      if (port) {
        streamPorts.delete(requestId);
      }
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response?.success) {
        if (response.content?.includes("</think>")) {
          response.content = response.content.split("</think>")[1].trim();
        }
        resolve(response.content || "");
      } else {
        reject(new Error(response?.error || "Unknown error"));
      }
    });
  });
}

// ==================== Prompt 构建函数 ==

// Prompt: 从单个标签页内容中提取与问题相关的信息
function buildExtractFromContentPrompt(
  content: string,
  question: string,
  index: number
): Array<{ role: string; content: string }> {
  return [
    {
      role: "system",
      content: [
        `You are extracting information from the content of tab ${index}.`,
        `Focus ONLY on the content provided below. Do NOT reference or speculate about other tabs.`,
        "",
        "Rules:",
        "- If the content contains ANY data related to the question (prices, names, quantities, dates, etc.), extract and present it as concise bullet points.",
        "- ALWAYS include exact numbers (review counts, ratings, prices, quantities) in your extraction — these are critical for filtering.",
        "- Even a single relevant data point (e.g. one product's price) counts as relevant — extract it.",
        // "- Only say 'N/A' if the content is COMPLETELY unrelated to the question.",
        // "- Do NOT say N/A just because this tab alone cannot fully answer the question.",
        "- Do NOT mention or refer to any other tabs. Only describe what is in THIS content.",
        "- No conversational filler."
      ].join("\n")
    },
    {
      role: "user",
      content: `Content of tab ${index}:\n${content.substring(0, CONFIG.maxContentLength)}\n\nQUESTION: ${question}`
    }
  ];
}

// Prompt: 单标签页问答
function buildSingleTabPrompt(
  pageContext: string,
  userMessage: string
): Array<{ role: string; content: string }> {
  return [
    {
      role: "system",
      content: `You are a helpful assistant. Here is the content of the browser tab:\n\n${pageContext.substring(0, CONFIG.maxContentLength)}\n\nPlease answer questions about this webpage. Keep your response concise and do NOT repeat the same information.`
    },
    { role: "user", content: `QUESTION: ${userMessage}` }
  ];
}

// Prompt: 评估摘要是否足以回答问题
function buildSummaryEvaluationPrompt(
  cachedSummary: string,
  userMessage: string
): Array<{ role: string; content: string }> {
  return [
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
        "You MUST follow one of these two response formats exactly (no markdown, no asterisks, no extra text):",
        "",
        "Case 1 – Summary is sufficient to answer the question:",
        "SUFFICIENT: yes",
        "ANSWER: <concise answer with the key facts extracted from the summary>",
        "",
        "Case 2 – Summary lacks enough detail to verify all constraints:",
        "SUFFICIENT: no"
      ].join("\n")
    },
    {
      role: "user",
      content: `SUMMARY: ${cachedSummary}\n\nQUESTION: ${userMessage}`
    }
  ];
}

// Prompt: 多标签页合并结果后的最终问答
function buildMultiTabFinalPrompt(
  tabs: Array<{ index: number; title: string; url: string; compressed: string }>,
  totalTabCount: number,
  userMessage: string
): Array<{ role: string; content: string }> {
  const combinedContext = tabs
    .map((tabInfo) =>
      `### Tab ${tabInfo.index}: ${tabInfo.title}\n${tabInfo.compressed}\n`
    )
    .join("\n");

  return [
    {
      role: "system",
      content: `You are a helpful assistant. Below is the extracted information from ${tabs.length} tabs:\n\n${combinedContext.substring(0, CONFIG.maxContentLength)}\n\n`
        + `Instructions:\n`
        + `- Answer the question strictly based on the information from the tabs above.\n`
        + `- When the question references information across multiple tabs, you MUST cross-reference: look up the value from one tab and match/compare it against the data from the other tab.\n`
        + `- Focus on what the user is actually asking — they may want to combine or compare specific attributes across tabs.\n`
        + `- Be concise and NEVER repeat the same sentence, phrase, or point.`
    },
    { role: "user", content: `QUESTION: ${userMessage}` }
  ];
}

// Prompt: 页面摘要生成
function buildSummarizePagePrompt(
  title: string,
  content: string
): Array<{ role: string; content: string }> {
  return [
    {
      role: "system",
      content: [
        "You are a helpful assistant that summarizes web pages into concise bullet points.",
        "",
        "Rules:",
        "- Produce concise bullet points covering the main topics, key facts, and important details.",
        "- ALWAYS include exact numbers (prices, ratings, counts, dates, percentages, quantities) — these are critical.",
        "- Each bullet point must convey a distinct piece of information. Do NOT repeat the same point in different words.",
        "- Use short, factual statements. No conversational filler, no greetings, no meta-commentary.",
        "- Do NOT speculate or add information not present in the content.",
      ].join("\n")
    },
    {
      role: "user",
      content: `Summarize this webpage:\n\nTitle: ${title}\n\nContent:\n${content.substring(0, CONFIG.maxContentLength)}`
    }
  ];
}

// Prompt: 根据用户问题为每个标签页生成子问题
function buildSubQuestionGenerationPrompt(
  tabs: Array<{ index: number; title: string }>,
  userMessage: string
): Array<{ role: string; content: string }> {
  const tabList = tabs.map(t => `- Tab ${t.index}: ${t.title}`).join("\n");
  return [
    {
      role: "system",
      content: [
        "You are a helpful assistant that decomposes a user question into per-tab sub-questions.",
        "Given the list of open browser tabs and the user's question, generate a focused sub-question for EACH tab that will help gather the information needed to answer the overall question.",
        "",
        "Rules:",
        "- Output EXACTLY one line per tab.",
        "- Each line MUST follow the format:  tab <index> question: <sub-question>",
        "- The sub-question should ask for the specific information that this tab is likely to contain, based on its title.",
        "- Do NOT add any other text, explanation, or formatting."
      ].join("\n")
    },
    {
      role: "user",
      content: `Tabs:\n${tabList}\n\nUser question: ${userMessage}`
    }
  ];
}

// 解析子问题生成结果，返回 { tabIndex -> subQuestion } 映射
// 兼容两种格式：
//   1. 标准格式（每行一个）: tab 1 question: xxx\ntab 2 question: xxx
//   2. 模型省略 "question:" 且无换行: tab 1  xxx?tab 2  xxx?
function parseSubQuestions(response: string): Map<number, string> {
  const map = new Map<number, string>();

  // 先尝试标准格式（按行解析，含 "question:"/"Question:" 关键词）
  // 兼容: "tab 1 question:", "Tab1 Question:", "Tab #1 question:", "TAB 1 QUESTION:" 等
  const lines = response.split("\n").map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const match = line.match(/tab\s*#?\s*(\d+)\s*[:\-]?\s*question\s*:\s*(.+)/i);
    if (match) {
      const idx = parseInt(match[1], 10);
      map.set(idx, match[2].trim());
    }
  }

  // 如果标准格式没有解析到任何结果，回退到宽松模式：
  // 用正则全局匹配 "tab <n>" 边界来拆分，不要求 "question:" 关键词
  // 兼容: "Tab1 xxx", "tab 1  xxx", "Tab #2 xxx" 等（均大小写不敏感）
  if (map.size === 0) {
    const relaxedRegex = /tab\s*#?\s*(\d+)\s*[:\-]?\s*(?:question\s*:\s*)?([\s\S]*?)(?=tab\s*#?\s*\d+\s*[:\-]?\s|$)/gi;
    let m: RegExpExecArray | null;
    while ((m = relaxedRegex.exec(response)) !== null) {
      const idx = parseInt(m[1], 10);
      const q = m[2].trim();
      if (q) {
        map.set(idx, q);
      }
    }
  }

  // 对于未解析到的标签页，回退使用原始 userMessage（不应发生，但作为安全保障）
  // 调用方自行处理 fallback
  return map;
}

// 处理多标签页查询 - 核心逻辑
async function processMultiTabQuery(
  allTabContents: TabContentInfo[],
  userMessage: string,
  port: chrome.runtime.Port,
): Promise<MultiTabQueryResult> {

  if (allTabContents.length <= 1) {
    // 单个标签页或无标签页，使用简单逻辑
    const pageContext = allTabContents
      .map((tabInfo) =>
        `### Tab ${tabInfo.index}: ${tabInfo.title}\n\n${tabInfo.content}\n\n`
      )
      .join("\n");

    return {
      success: true,
      finalMessages: buildSingleTabPrompt(pageContext, userMessage)
    };
  }

  console.log(`[Background] Processing ${allTabContents.length} tabs with DATA FLOW_TYPE=${DATA_FLOW_TYPE}...`);

  // ---------- DATA FLOW 1: 直接把原始内容当作 compressed，跳过中间推理 ----------
  if (DATA_FLOW_TYPE === 1) {
    const tabsWithContent = allTabContents.map(tabInfo => ({
      index: tabInfo.index,
      title: tabInfo.title,
      url: tabInfo.url,
      compressed: tabInfo.content.substring(0, CONFIG.maxContentLength),
    }));
    return {
      success: true,
      finalMessages: buildMultiTabFinalPrompt(tabsWithContent, allTabContents.length, userMessage)
    };
  }

  // ---------- 对于 DATA FLOW 5 / 6: 先生成子问题 ----------
  let subQuestions: Map<number, string> | null = null;
  if (DATA_FLOW_TYPE === 5 || DATA_FLOW_TYPE === 6) {
    const tabMeta = allTabContents.map(t => ({ index: t.index, title: t.title }));
    const subQPrompt = buildSubQuestionGenerationPrompt(tabMeta, userMessage);
    try {
      const subQResponse = await silentChat(subQPrompt, port);
      console.log("[Background] Sub-question response:", subQResponse);
      subQuestions = parseSubQuestions(subQResponse);
    } catch (err) {
      if (err instanceof Error && err.message.includes("Port disconnected")) throw err;
      console.error("[Background] Failed to generate sub-questions, falling back to userMessage:", err);
    }
  }

  // ---------- Phase 1: 逐标签页压缩 ----------
  const compressedTabContents: {
    index: number;
    title: string;
    url: string;
    compressed: string;
  }[] = [];

  for (let i = 0; i < allTabContents.length; i++) {
    const tabInfo = allTabContents[i];
    console.log(`[Background] Processing tab ${tabInfo.index}/${allTabContents.length}: ${tabInfo.title}`);

    // 确定本标签页使用的问题文本
    const tabQuestion = subQuestions?.get(tabInfo.index) || userMessage;
    if (subQuestions) {
      console.log(`[Background] Tab ${tabInfo.index} sub-question: ${tabQuestion}`);
    }

    let compressedContent = "";

    try {
      switch (DATA_FLOW_TYPE) {
        // --- DATA FLOW 2: 用 userMessage + content 提取 ---
        case 2: {
          const msgs = buildExtractFromContentPrompt(tabInfo.content, userMessage, tabInfo.index);
          compressedContent = await silentChat(msgs, port);
          console.log(`[Background] [WF2] extracted: ${compressedContent}`);
          break;
        }

        // --- DATA FLOW 3: 用 userMessage + cachedSummary 提取 ---
        case 3: {
          const source = tabInfo.cachedSummary || tabInfo.content;
          const msgs = buildExtractFromContentPrompt(source, userMessage, tabInfo.index);
          compressedContent = await silentChat(msgs, port);
          console.log(`[Background] [WF3] extracted (from ${tabInfo.cachedSummary ? "summary" : "content"}): ${compressedContent}`);
          break;
        }

        // --- DATA FLOW 4: 先评估 cachedSummary，不足则回退 content ---
        case 4: {
          if (tabInfo.cachedSummary) {
            const evalMsgs = buildSummaryEvaluationPrompt(tabInfo.cachedSummary, userMessage);
            const evalResp = await silentChat(evalMsgs, port);
            const parsed = parseSummaryResponse(evalResp);

            if (parsed.sufficient) {
              compressedContent = parsed.answer;
            } else {
              // 摘要不足，回退到 content
              const fallback = buildExtractFromContentPrompt(tabInfo.content, userMessage, tabInfo.index);
              compressedContent = await silentChat(fallback, port);
              console.log(`[Background] [WF4] Insufficient summary for: ${tabInfo.title}, extracted: ${compressedContent}`);
            }
          } else {
            // 无摘要，直接用 content
            const msgs = buildExtractFromContentPrompt(tabInfo.content, userMessage, tabInfo.index);
            compressedContent = await silentChat(msgs, port);
            console.log(`[Background] [WF4] No summary, extracted: ${compressedContent}`);
          }
          break;
        }

        // --- DATA FLOW 5: 子问题 + content 提取 ---
        case 5: {
          const msgs = buildExtractFromContentPrompt(tabInfo.content, tabQuestion, tabInfo.index);
          compressedContent = await silentChat(msgs, port);
          console.log(`[Background] [WF5] extracted: ${compressedContent}`);
          break;
        }

        // --- DATA FLOW 6: 子问题 + 先评估 cachedSummary，不足则回退 content ---
        case 6: {
          if (tabInfo.cachedSummary) {
            const evalMsgs = buildSummaryEvaluationPrompt(tabInfo.cachedSummary, tabQuestion);
            const evalResp = await silentChat(evalMsgs, port);
            const parsed = parseSummaryResponse(evalResp);

            if (parsed.sufficient) {
              compressedContent = parsed.answer;
            } else {
              const fallback = buildExtractFromContentPrompt(tabInfo.content, tabQuestion, tabInfo.index);
              compressedContent = await silentChat(fallback, port);
              console.log(`[Background] [WF6] Insufficient summary for: ${tabInfo.title}, extracted: ${compressedContent}`);
            }
          } else {
            const msgs = buildExtractFromContentPrompt(tabInfo.content, tabQuestion, tabInfo.index);
            compressedContent = await silentChat(msgs, port);
            console.log(`[Background] [WF6] No summary, extracted: ${compressedContent}`);
          }
          break;
        }

        default:
          console.warn(`[Background] Unknown DATA FLOW_TYPE: ${DATA_FLOW_TYPE}, falling back to WF2`);
          const msgs = buildExtractFromContentPrompt(tabInfo.content, userMessage, tabInfo.index);
          compressedContent = await silentChat(msgs, port);
          break;
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("Port disconnected")) throw err;
      console.error(`[Background] Error processing tab ${tabInfo.title}:`, err);
      compressedContent = "Error processing this tab";
    }

    compressedTabContents.push({
      index: tabInfo.index,
      title: tabInfo.title,
      url: tabInfo.url,
      compressed: compressedContent,
    });
  }

  // ---------- Phase 2: 组合所有标签页 ----------
  console.log(`[Background] Using all ${compressedTabContents.length} tabs`);

  return {
    success: true,
    finalMessages: buildMultiTabFinalPrompt(compressedTabContents, allTabContents.length, userMessage)
  };
}

// ==================== 页面摘要 ====================

async function summarizePage(
  url: string,
  title: string,
  content: string
): Promise<{ summary: string }> {
  console.log("[Background] Summarizing page:", title);

  const messages = buildSummarizePagePrompt(title, content);

  const summary = await silentChat(messages);
  console.log("[Background] Summary generated:", summary.length, "chars\n"+summary);
  return { summary };
}

// ==================== 用户提问优先级控制 ====================

/**
 * 请求暂停摘要队列，等待当前正在进行的任务完成后让出引擎。
 * 如果摘要队列未在运行，则立即返回。
 */
async function pauseSummarizationForUserQuery(): Promise<void> {
  if (!isSummarizing) return;
  if (userQueryPending) return; // 已经暂停

  userQueryPending = true;
  console.log("[Background] Requesting summarization pause for user query...");

  // 创建恢复 Promise（摘要循环将等待此 Promise）
  summarizationResumePromise = new Promise<void>(resolve => {
    summarizationResumeResolve = resolve;
  });

  // 等待摘要循环实际让出（当前任务完成后触发）
  await new Promise<void>(resolve => {
    summarizationYieldedResolve = resolve;
  });

  console.log("[Background] Summarization paused, engine available for user query");
}

/**
 * 恢复摘要队列处理。
 * 在用户提问的流式生成完成（或出错/断开）后调用。
 */
function resumeSummarization(): void {
  if (!userQueryPending) return;

  userQueryPending = false;
  console.log("[Background] Resuming summarization queue");

  if (summarizationResumeResolve) {
    summarizationResumeResolve();
    summarizationResumeResolve = null;
  }
  summarizationResumePromise = null;
}

// ==================== 摘要队列处理 ====================

async function processSummarizationQueue() {
  if (isSummarizing || summarizationQueue.length === 0 || !engineReady) {
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

    try {
      const response = await summarizePage(
        pageData.url,
        pageData.title,
        pageData.content.substring(0, CONFIG.maxContentLength)
      );

      if (response.summary) {
        await saveCachedSummary({
          url: pageData.url,
          title: pageData.title,
          summary: response.summary,
          timestamp: Date.now(),
          contentLength: pageData.content.length
        });
        await removePendingPage(url);
      }
    } catch (err) {
      console.error("[Background] Summarization failed:", err);
      await removePendingPage(url);
    }

    // 每完成一个任务后检查：如果有用户提问等待，让出引擎
    if (userQueryPending) {
      console.log("[Background] Summarization yielding for user query");
      if (summarizationYieldedResolve) {
        summarizationYieldedResolve();
        summarizationYieldedResolve = null;
      }
      if (summarizationResumePromise) {
        await summarizationResumePromise;
      }
      console.log("[Background] Summarization resumed after user query");
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
      engineReady = true;
      engineInitProgress = 1;
      isEngineInitializing = false;
      console.log("[Background] Engine ready!");
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
          // 通知 startStreaming 的等待方：流式生成已结束
          const completionCb = streamCompletionCallbacks.get(chunk.requestId);
          if (completionCb) {
            completionCb();
            streamCompletionCallbacks.delete(chunk.requestId);
          }
        }
      }
      sendResponse({ status: "acknowledged" });
      return true;
    }

    // ==================== Popup 请求 ====================
    case "GET_ENGINE_STATUS":
      sendResponse({
        ready: engineReady,
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

      if (newModelId === currentModelId) {
        sendResponse({ success: true, status: "same_model" });
        return true;
      }

      if (isEngineInitializing) {
        sendResponse({ success: false, error: "Engine is currently initializing, please wait before switching models" });
        return true;
      }

      // Save to storage (fire and forget)
      saveModelIdToStorage(newModelId).catch(err =>
        console.error("[Background] Failed to save model ID:", err)
      );

      // 立即返回响应，让 popup 可以开始轮询进度
      sendResponse({ success: true, status: "loading", modelId: newModelId });

      // 异步重新加载模型（状态由 initializeEngine 内部集中管理）
      initializeEngine(newModelId).catch(err =>
        console.error("[Background] Model reload failed:", err)
      );
      return true;
    }

    case "GET_SAVED_MODEL_ID":
      loadModelIdFromStorage().then(modelId => {
        sendResponse({ modelId });
      });
      return true;


    // ==================== 页面内容处理 ====================
    case "PAGE_LOADED": {
      const { url, title, content } = message.data;
      console.log("[Background] PAGE_LOADED:", title, "length:", content?.length);

      if (USE_SUMMARY_CACHE && content && content.length > CONFIG.minContentLength) {
        queuePageForSummarization(url, title, content).then(() => {
          sendResponse({ status: "queued" });
        });
      } else {
        sendResponse({ status: "skipped" });
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
  if (!engineReady) {
    port.postMessage({ type: "status", status: "initializing", progress: engineInitProgress });
    const result = await initializeEngine(currentModelId);
    if (result.status === "error") {
      port.postMessage({ type: "error", error: result.error || "Engine initialization failed" });
      return false;
    }
  }
  if (!engineReady) {
    port.postMessage({ type: "error", error: "Engine not ready" });
    return false;
  }
  return true;
}

/**
 * 启动流式生成，返回的 Promise 在流式生成完成（done / error）时 resolve。
 * 这确保调用方可以 await 等待引擎空闲后再恢复摘要队列。
 */
async function startStreaming(port: chrome.runtime.Port, messages: any[]): Promise<void> {
  // if (!await ensureEngineReadyForPort(port)) return;
  messages = appendNothinkIfQwen3(messages);

  const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  // 注册端口用于接收 streaming 响应
  streamPorts.set(requestId, port);

  return new Promise<void>((resolve) => {
    // 注册完成回调 —— 当 STREAM_CHUNK 收到 done/error 或端口断开时触发
    streamCompletionCallbacks.set(requestId, resolve);

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
        streamCompletionCallbacks.delete(requestId);
        resolve();
      } else if (response?.error) {
        console.error("[Background] Stream start error:", response.error);
        port.postMessage({ type: "error", error: response.error });
        streamPorts.delete(requestId);
        streamCompletionCallbacks.delete(requestId);
        resolve();
      }
    });
  });
}

// ==================== Port 连接（用于 Streaming Chat）====================

chrome.runtime.onConnect.addListener((port) => {
  console.log("[Background] Port connected:", port.name);

  if (port.name === "chat_stream") {
    // 为该端口创建活跃请求集合
    // portActiveRequests.set(port, new Set<string>());

    // Streaming chat 连接
    port.onMessage.addListener(async (message) => {
      if (message.type === "CHAT_STREAM_START") {
        // 直接 streaming：sidebar 已构建好 messages
        // 暂停摘要队列，等待当前摘要任务完成后让出引擎
        await pauseSummarizationForUserQuery();
        try {
          await startStreaming(port, message.messages);
        } finally {
          resumeSummarization();
        }
      } else if (message.type === "PROCESS_AND_STREAM") {
        // 合并请求：background 自行收集标签页内容 + 处理多标签页 + streaming
        try {
          // if (!await ensureEngineReadyForPort(port)) return;

          const { userMessage, useContext } = message;

          // 先收集标签页内容（不需要 LLM 引擎，可在摘要运行时并行执行）
          // 必须在 pauseSummarizationForUserQuery 之前调用，
          // 否则 await 内部 Promise 会打断 service worker 事件上下文，
          // 导致 chrome.tabs.query 返回空数组。
          let tabContents: TabContentInfo[] = [];
          if (useContext) {
            tabContents = await fetchAllTabContents();
            console.log(`[Background] Fetched ${tabContents.length} tabs`);
          }

          // 暂停摘要队列，等待当前摘要任务完成后让出引擎
          await pauseSummarizationForUserQuery();

          const queryResult = await processMultiTabQuery(tabContents, userMessage, port);

          if (!queryResult.success || !queryResult.finalMessages) {
            port.postMessage({ type: "error", error: queryResult.error || "Failed to process query" });
            resumeSummarization();
            return;
          }

          // 直接将处理结果发送 streaming，中间结果不经由 sidebar
          await startStreaming(port, queryResult.finalMessages);
          resumeSummarization();
        } catch (err) {
          console.error("[Background] Error in PROCESS_AND_STREAM:", err);
          port.postMessage({ type: "error", error: String(err) });
          resumeSummarization();
        }
      }
    });

    port.onDisconnect.addListener(() => {
      console.log("[Background] Stream port disconnected");

      for (const [requestId, p] of streamPorts.entries()) {
        if (p === port) {
          streamPorts.delete(requestId);

          // 通知 offscreen 中止生成任务
          chrome.runtime.sendMessage({
            type: "ABORT_REQUEST",
            data: { requestId }
          }, () => {
            // 忽略 lastError（offscreen 可能已关闭）
            if (chrome.runtime.lastError) {
              console.warn(`[Background] Failed to send ABORT_REQUEST for ${requestId}:`, chrome.runtime.lastError.message);
            } else {
              console.log(`[Background] Sent ABORT_REQUEST for ${requestId}`);
            }
          });

          // 解决 startStreaming 的完成回调（避免 Promise 永远 pending）
          const completionCb = streamCompletionCallbacks.get(requestId);
          if (completionCb) {
            completionCb();
            streamCompletionCallbacks.delete(requestId);
          }

          // 拒绝 silentChat 的 pending promise
          const rejectFn = pendingRejects.get(requestId);
          if (rejectFn) {
            console.log(`[Background] Rejecting pending request ${requestId} due to port disconnect`);
            rejectFn(new Error("Port disconnected, request aborted"));
            pendingRejects.delete(requestId);
          }
        }
      }

      // 端口断开时恢复摘要队列（如果之前因用户提问而暂停）
      resumeSummarization();
    });
  }
});

// ==================== 初始化 ====================

// 设置点击扩展图标时打开侧边栏
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// 启动时加载保存的模型 ID 并创建 offscreen document，然后开始初始化引擎
(async () => {
  currentModelId = await loadModelIdFromStorage();
  console.log("[Background] Loaded model ID from storage:", currentModelId);

  await ensureOffscreenDocument();
  console.log("[Background] Offscreen document ready, checking engine status...");

  // 先查询 offscreen 当前状态（应对 background 重启但 offscreen 仍运行的场景）
  const result = await initializeEngine(currentModelId);
  console.log("[Background] Initial engine load result:", result.status);
})();
