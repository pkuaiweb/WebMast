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
let currentModelId = "";

// ==================== 计时器 ====================

let timerInterval: ReturnType<typeof setInterval> | null = null;
let timerStartTime = 0;
let timerFrozen = false;

function startTimer() {
  // 清理旧计时器
  if (timerInterval !== null) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  timerFrozen = false;
  timerStartTime = Date.now();
  const el = document.getElementById("elapsed-timer");
  if (el) el.textContent = "TTFT : 0.0s";

  timerInterval = setInterval(() => {
    if (!timerFrozen) {
      const elapsed = ((Date.now() - timerStartTime) / 1000).toFixed(1);
      if (el) el.textContent = `TTFT : ${elapsed}s`;
    }
  }, 100);
}

function freezeTimer() {
  if (!timerFrozen) {
    timerFrozen = true;
    if (timerInterval !== null) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    // 显示最终时间
    const el = document.getElementById("elapsed-timer");
    const elapsed = ((Date.now() - timerStartTime) / 1000).toFixed(1);
    if (el) el.textContent = `TTFT : ${elapsed}s`;
  }
}

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
  const checkInterval = 2000;
  const maxWaitTime = 120000; // 2分钟超时
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    const check = async () => {
      const status = await checkEngineStatus();
      console.log("[Sidebar] Engine status:", status.ready ? "ready" : "not ready", `(${Math.round(status.progress * 100)}%)`);
      progressBar.animate(status.progress, { duration: 50 });
      
      if (status.ready) {
        enableInputs();
        resolve();
      } 
      // else if (Date.now() - startTime > maxWaitTime) {
      //   reject(new Error("Engine initialization timeout"));
      // } 
      else {
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
  document.getElementById("answerWrapper")!.style.display = "block";
  document.getElementById("loading-indicator")!.style.display = "block";
  const elapsedTimerEl = document.getElementById("elapsed-timer");
  if (elapsedTimerEl) elapsedTimerEl.style.display = "inline";
  const copyBtn = document.getElementById("copyAnswer") as HTMLButtonElement | null;
  if (copyBtn) copyBtn.style.visibility = "hidden";
  startTimer();

  try {
    // 一次请求：background 自行收集标签页内容 + 多标签页处理 + streaming 输出
    await processAndStream(message);
  } catch (err) {
    console.error("[Sidebar] Chat error:", err);
    freezeTimer();
    document.getElementById("loading-indicator")!.style.display = "none";
    document.getElementById("answer")!.innerHTML = `Error: ${err}`;
  }
}

// 发送用户消息到 background，由 background 自行收集标签页内容 + 处理 + streaming
async function processAndStream(userMessage: string): Promise<string> {
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
          updateAnswer(fullMessage);
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
      type: "PROCESS_AND_STREAM",
      userMessage: userMessage,
      useContext: useContext
    });
  });
}

// ==================== UI 更新 ====================

function updateAnswer(answer: string) {
  freezeTimer();
  document.getElementById("loading-indicator")!.style.display = "none";
  const copyBtn = document.getElementById("copyAnswer") as HTMLButtonElement | null;
  if (copyBtn) {
    copyBtn.style.visibility = "visible";
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(answer)
        .then(() => console.log("[Sidebar] Answer copied"))
        .catch((err) => console.error("[Sidebar] Copy error:", err));
    };
  }
  const answerWithBreaks = answer.replace(/\n/g, "<br>");
  document.getElementById("answer")!.innerHTML = answerWithBreaks;
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
