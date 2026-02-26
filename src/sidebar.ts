"use strict";

/**
 * Sidebar - 用户界面层
 * 
 * 职责：
 * - 用户输入/输出
 * - 通过 Background 控制平面发送请求
 * - 接收 Streaming 响应并渲染
 */

// This code is partially adapted from the openai-chatgpt-chrome-extension repo:
// https://github.com/jessedi0n/openai-chatgpt-chrome-extension

import "./sidebar.css";
import { ProgressBar, Line } from "progressbar.js";
import { prebuiltAppConfig, ModelRecord } from "@mlc-ai/web-llm";

// ==================== 类型定义 ====================

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface CachedSummaryData {
  url: string;
  title: string;
  summary: string;
  timestamp: number;
  contentLength: number;
}

interface TabContent {
  title: string;
  url: string;
  content: string;
  cachedSummary?: string;
  hasCachedSummary: boolean;
}

interface StreamChunk {
  requestId: string;
  chunk?: string;
  done?: boolean;
  error?: string;
  usage?: any;
}

// ==================== 配置 ====================

const useContext = true;
console.log("[Sidebar] useContext:", useContext);

// ==================== Model Configuration ====================

// Get available models from web-llm config (filter for LLM models suitable for extension)
function getAvailableModels(): ModelRecord[] {
  return prebuiltAppConfig.model_list.filter(model => {
    // Filter for reasonable size models (under 8GB VRAM) for browser extension use
    const vram = model.vram_required_MB || 0;
    return vram > 0 && vram < 8000 && model.model_id;
  });
}

const AVAILABLE_MODELS = getAvailableModels();

// ==================== UI 元素 ====================

const queryInput = document.getElementById("query-input")! as HTMLInputElement;
const submitButton = document.getElementById("submit-button")! as HTMLButtonElement;

// Settings elements
const settingsButton = document.getElementById("settings-button")! as HTMLButtonElement;
const backButton = document.getElementById("back-button")! as HTMLButtonElement;
const chatPage = document.getElementById("chat-page")! as HTMLDivElement;
const settingsPage = document.getElementById("settings-page")! as HTMLDivElement;
const modelSelect = document.getElementById("model-select")! as HTMLSelectElement;
const modelInfo = document.getElementById("model-info")! as HTMLDivElement;
const saveSettingsButton = document.getElementById("save-settings")! as HTMLButtonElement;
const settingsStatus = document.getElementById("settings-status")! as HTMLDivElement;
const currentModelDisplay = document.getElementById("current-model-display")! as HTMLSpanElement;

submitButton.disabled = true;

const progressBar: ProgressBar = new Line("#loadingContainer", {
  strokeWidth: 4,
  easing: "easeInOut",
  duration: 1400,
  color: "#ffd166",
  trailColor: "#eee",
  trailWidth: 1,
  svgStyle: { width: "100%", height: "100%" },
});

// ==================== 状态管理 ====================

let isLoadingParams = true;
let allTabContents: TabContent[] = [];
let currentModelId = "";

// ==================== Settings Functions ====================

function populateModelSelect(selectedModelId?: string) {
  modelSelect.innerHTML = "";
  
  AVAILABLE_MODELS.forEach(model => {
    const option = document.createElement("option");
    option.value = model.model_id;
    option.textContent = model.model_id;
    if (model.model_id === selectedModelId) {
      option.selected = true;
    }
    modelSelect.appendChild(option);
  });
  
  updateModelInfo();
}

function updateModelInfo() {
  const selectedId = modelSelect.value;
  const model = AVAILABLE_MODELS.find(m => m.model_id === selectedId);
  
  if (model) {
    const vram = model.vram_required_MB?.toFixed(0) || "Unknown";
    const lowResource = model.low_resource_required ? "Yes" : "No";
    modelInfo.innerHTML = `
      <div><strong>VRAM Required:</strong> ${vram} MB</div>
      <div><strong>Low Resource:</strong> ${lowResource}</div>
    `;
  } else {
    modelInfo.innerHTML = "";
  }
}

function showSettingsPage() {
  chatPage.style.display = "none";
  settingsPage.style.display = "block";
  settingsStatus.textContent = "";
  
  // Disable save button if engine is not ready
  saveSettingsButton.disabled = isLoadingParams;
  
  // Get current model and populate select
  chrome.runtime.sendMessage({ type: "GET_SAVED_MODEL_ID" }, (response) => {
    const savedModelId = response?.modelId || AVAILABLE_MODELS[0]?.model_id;
    populateModelSelect(savedModelId);
  });
}

function showChatPage() {
  settingsPage.style.display = "none";
  chatPage.style.display = "block";
}

async function saveSettings() {
  const newModelId = modelSelect.value;
  
  if (!newModelId) {
    settingsStatus.textContent = "Please select a model.";
    return;
  }
  
  settingsStatus.textContent = "Saving...";
  saveSettingsButton.disabled = true;
  
  chrome.runtime.sendMessage({
    type: "CHANGE_MODEL",
    data: { modelId: newModelId }
  }, (response) => {
    if (chrome.runtime.lastError) {
      settingsStatus.textContent = "Error: " + chrome.runtime.lastError.message;
      saveSettingsButton.disabled = false;
      return;
    }
    
    if (response?.success) {
      if (response.status === "same_model") {
        settingsStatus.textContent = "Model unchanged.";
        saveSettingsButton.disabled = false;
      } else {
        currentModelId = newModelId;
        updateCurrentModelDisplay();
        settingsStatus.textContent = "Model changed! Reloading engine...";
        
        // Go back to chat page and show loading
        showChatPage();
        isLoadingParams = true;
        submitButton.disabled = true;
        
        // Show loading bar
        const loadingContainer = document.getElementById("loadingContainer");
        if (loadingContainer) {
          loadingContainer.style.display = "block";
        }
        
        // Wait for new engine (不需要再调用 initializeEngine，CHANGE_MODEL 已触发)
        waitForEngineReady().then(() => {
          console.log("[Sidebar] New model loaded successfully");
        }).catch(err => {
          console.error("[Sidebar] Failed to load new model:", err);
        });
      }
    } else {
      settingsStatus.textContent = "Error: " + (response?.error || "Unknown error");
      saveSettingsButton.disabled = false;
    }
  });
}

function updateCurrentModelDisplay() {
  if (currentModelId) {
    // Show shortened model name
    const shortName = currentModelId.replace("-MLC", "").substring(0, 25);
    currentModelDisplay.textContent = shortName + (currentModelId.length > 25 ? "..." : "");
    currentModelDisplay.title = currentModelId;
  } else {
    currentModelDisplay.textContent = "Loading...";
  }
}

// Settings event listeners
settingsButton.addEventListener("click", showSettingsPage);
backButton.addEventListener("click", showChatPage);
modelSelect.addEventListener("change", updateModelInfo);
saveSettingsButton.addEventListener("click", saveSettings);

// ==================== 引擎状态管理 ====================

async function checkEngineStatus(): Promise<{ ready: boolean; progress: number; modelId?: string }> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_ENGINE_STATUS" }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn("[Sidebar] Error checking engine status:", chrome.runtime.lastError);
        resolve({ ready: false, progress: 0 });
      } else {
        // Update current model display
        if (response?.modelId) {
          currentModelId = response.modelId;
          updateCurrentModelDisplay();
        }
        resolve(response || { ready: false, progress: 0 });
      }
    });
  });
}


// 仅轮询等待引擎就绪（不触发初始化，用于已知正在初始化的场景）
async function waitForEngineReady(): Promise<void> {
  const checkInterval = 500;
  const maxWaitTime = 120000; // 2分钟超时
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    const check = async () => {
      const status = await checkEngineStatus();
      
      progressBar.animate(status.progress, { duration: 50 });
      
      if (status.ready) {
        enableInputs();
        resolve();
      } else if (Date.now() - startTime > maxWaitTime) {
        reject(new Error("Engine initialization timeout"));
      } else {
        setTimeout(check, checkInterval);
      }
    };
    
    check();
  });
}

function enableInputs() {
  if (isLoadingParams) {
    submitButton.disabled = false;
    const loadingBarContainer = document.getElementById("loadingContainer");
    if (loadingBarContainer) {
      loadingBarContainer.style.display = "none";
    }
    queryInput.focus();
    isLoadingParams = false;
  }
}

// ==================== Streaming Chat ====================

// updateUI: true 更新 UI（最终答案），false 静默模式（中间处理）
async function sendStreamingChat(messages: ChatMessage[], updateUI: boolean = true): Promise<string> {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: "chat_stream" });
    let fullMessage = "";

    port.onMessage.addListener((message) => {
      if (message.type === "chunk") {
        const chunk = message.data as StreamChunk;
        
        if (chunk.error) {
          reject(new Error(chunk.error));
          port.disconnect();
          return;
        }

        if (chunk.chunk) {
          fullMessage += chunk.chunk;
          if (updateUI) {
            updateAnswer(fullMessage);
          }
        }

        if (chunk.done) {
          console.log("fullMessage:", fullMessage);
          resolve(fullMessage);
          port.disconnect();
        }
      } else if (message.type === "status") {
        console.log("[Sidebar] Engine status:", message.status, message.progress);
      } else if (message.type === "error") {
        reject(new Error(message.error));
        port.disconnect();
      }
    });

    port.onDisconnect.addListener(() => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      }
    });

    port.postMessage({
      type: "CHAT_STREAM_START",
      messages: messages
    });
  });
}

// ==================== 事件监听器 ====================

queryInput.addEventListener("keyup", () => {
  submitButton.disabled = queryInput.value === "";
});

queryInput.addEventListener("keyup", (event) => {
  if (event.code === "Enter") {
    event.preventDefault();
    submitButton.click();
  }
});

submitButton.addEventListener("click", handleClick);

// ==================== 处理用户提交 ====================

async function handleClick() {
  const message = queryInput.value;
  console.log("[Sidebar] User message:", message);

  // 重置 UI
  document.getElementById("answer")!.innerHTML = "";
  document.getElementById("answerWrapper")!.style.display = "none";
  document.getElementById("loading-indicator")!.style.display = "block";

  try {
    // 每次提交时重新获取最新的页面内容和缓存摘要
    if (useContext) {
      allTabContents = await fetchPageContents();
      console.log(`[Sidebar] Fetched ${allTabContents.length} tabs`);
    }

    // 调用 Background 处理多标签页查询逻辑
    const result = await processMultiTabQueryViaBackground(allTabContents, message);
    
    if (!result.success) {
      throw new Error(result.error || "Failed to process query");
    }

    // 发送最终消息进行 streaming 输出
    await sendStreamingChat(result.finalMessages as ChatMessage[]);
  } catch (err) {
    console.error("[Sidebar] Chat error:", err);
    document.getElementById("loading-indicator")!.style.display = "none";
    document.getElementById("answerWrapper")!.style.display = "block";
    document.getElementById("answer")!.innerHTML = `Error: ${err}`;
  }
}

// 调用 Background 处理多标签页查询
async function processMultiTabQueryViaBackground(
  tabContents: TabContent[],
  userMessage: string
): Promise<{ success: boolean; finalMessages?: ChatMessage[]; error?: string }> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({
      type: "PROCESS_MULTI_TAB_QUERY",
      data: { tabContents, userMessage }
    }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response || { success: false, error: "No response" });
      }
    });
  });
}

// ==================== UI 更新 ====================

function updateAnswer(answer: string) {
  document.getElementById("answerWrapper")!.style.display = "block";
  const answerWithBreaks = answer.replace(/\n/g, "<br>");
  document.getElementById("answer")!.innerHTML = answerWithBreaks;

  // 复制按钮
  const copyButton = document.getElementById("copyAnswer");
  if (copyButton) {
    copyButton.onclick = () => {
      navigator.clipboard.writeText(answer)
        .then(() => console.log("[Sidebar] Answer copied"))
        .catch((err) => console.error("[Sidebar] Copy error:", err));
    };
  }

  // 时间戳
  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  };
  const time = new Date().toLocaleString("en-US", options);
  document.getElementById("timestamp")!.innerText = time;

  // 隐藏加载指示器
  document.getElementById("loading-indicator")!.style.display = "none";
}

// ==================== 获取页面内容 ====================

async function getCachedSummary(url: string): Promise<CachedSummaryData | null> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "GET_CACHED_SUMMARY", data: { url } },
      (response) => {
        if (chrome.runtime.lastError) {
          console.warn("[Sidebar] Error getting cached summary:", chrome.runtime.lastError);
          resolve(null);
        } else {
          resolve(response?.summary || null);
        }
      }
    );
  });
}

async function getAllCachedSummaries(): Promise<{ [url: string]: CachedSummaryData }> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "GET_ALL_CACHED_SUMMARIES" },
      (response) => {
        if (chrome.runtime.lastError) {
          console.warn("[Sidebar] Error getting cached summaries:", chrome.runtime.lastError);
          resolve({});
        } else {
          resolve(response?.summaries || {});
        }
      }
    );
  });
}

async function fetchPageContents(): Promise<TabContent[]> {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  if (tabs.length === 0) {
    console.warn("[Sidebar] No tabs found");
    return [];
  }

  const results: TabContent[] = [];
  const promises: Promise<void>[] = [];

  for (const tab of tabs) {
    if (!tab.id) continue;
    promises.push(
      new Promise<void>((resolve) => {
        try {
          const port = chrome.tabs.connect(tab.id!, { name: "channelName" });
          port.postMessage({});

          const timeout = setTimeout(() => {
            port.disconnect();
            resolve();
          }, 3000);

          port.onMessage.addListener(async (msg) => {
            clearTimeout(timeout);
            const tabUrl = tab.url || "Unknown URL";
            const cachedSummary = await getCachedSummary(tabUrl);

            results.push({
              title: tab.title || "Untitled",
              url: tabUrl,
              content: msg.contents,
              cachedSummary: cachedSummary?.summary,
              hasCachedSummary: !!cachedSummary
            });

            console.log(`[Sidebar] Tab loaded: ${tab.title}, has cached summary: ${!!cachedSummary}`);
            resolve();
          });

          port.onDisconnect.addListener(() => {
            clearTimeout(timeout);
            if (chrome.runtime.lastError) {
              console.warn(`[Sidebar] Could not connect to tab ${tab.id}: ${chrome.runtime.lastError.message}`);
            }
            resolve();
          });
        } catch (error) {
          console.warn(`[Sidebar] Failed to connect to tab ${tab.id}:`, error);
          resolve();
        }
      })
    );
  }

  await Promise.all(promises);
  return results;
}

// ==================== 初始化 ====================

async function init() {
  console.log("[Sidebar] Initializing...");
  
  // 等待引擎就绪
  try {
    await waitForEngineReady();
    console.log("[Sidebar] Engine ready, UI enabled");
  } catch (err) {
    console.error("[Sidebar] Engine initialization failed:", err);
    document.getElementById("answer")!.innerHTML = "Engine initialization failed. Please reload the extension.";
  }
}

// 启动
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
