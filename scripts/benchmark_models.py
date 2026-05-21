"""
WebMast Multi-Model Benchmark Script
======================================
对多个 Qwen3.5 模型（0.8B / 2B / 4B / 9B 等）在相同输入下测试：

  - TTFT   (Time To First Token)        — 首 token 延迟
  - TPOT   (Time Per Output Token)      — 解码每个 token 的平均时间
  - GPU    (Apple Silicon Utilization)  — 整数百分比 + 显存(MB)
  - MEM    (Browser RSS)                — 浏览器进程树 RSS 总和(MB)

工作流程
--------
1. 启动本地 HTTP 服务器，提供 files/html/ 中的离线 HTML（与 run_test_local.py 一致）
2. 启动 Edge 浏览器（加载 WebMast 扩展，持久化 profile）
3. 对每个待测 model_id：
   a. 通过扩展消息 `CHANGE_MODEL` 切换模型
   b. 等待引擎就绪
   c. 重复 N 次：
      - 启动后台采样线程（GPU/MEM）
      - 在 sidebar 页面 evaluate 一段 JS：自建 `chat_stream` 端口，
        逐 chunk 记录到达时间，最终从 `usage.completion_tokens` 拿到 token 数
      - 停止采样，汇总指标
4. 输出
      - per-model JSON: result/benchmark_<model>.json
      - 汇总: result/benchmark_summary.json + benchmark_summary.md

使用方式
--------
    # 默认 4 个 Qwen3.5 模型，固定任务 (gitlab task_id=0)，每个模型 3 次
    python scripts/benchmark_models.py

    # 指定模型 / 重复次数 / 任务文件 / 任务 ID
    python scripts/benchmark_models.py \\
        --models Qwen3.5-0.8B-q4f16_1-MLC Qwen3.5-2B-q4f16_1-MLC \\
        --repeats 5 \\
        --task-file gitlab.json --task-id 0

前置条件
--------
    pip install playwright psutil
    playwright install chromium
    先运行 save_pages.py 生成 files/html/url_map.json
"""

from __future__ import annotations

import argparse
import asyncio
import functools
import http.server
import json
import os
import re
import shutil
import statistics
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

import psutil
from playwright.async_api import async_playwright

# ==================== 配置 ====================

SCRIPT_DIR = Path(__file__).parent.resolve()
PROJECT_DIR = SCRIPT_DIR.parent  # WebMast/

EXTENSION_PATH = str(PROJECT_DIR / "dist")
USER_DATA_DIR = str(PROJECT_DIR / "test-profile")
HTML_DIR = str(PROJECT_DIR / "files" / "html")
URL_MAP_PATH = os.path.join(HTML_DIR, "url_map.json")
LOCAL_SERVER_PORT = 8765

DATA_DIR = str(PROJECT_DIR.parent / "Master-Thesis" / "data")
OUTPUT_DIR = str(PROJECT_DIR.parent / "Master-Thesis" / "result")

PAGE_LOAD_TIMEOUT = 60000           # ms
ENGINE_READY_TIMEOUT = 1800000      # ms （首次下载大模型权重需要较长）
ANSWER_TIMEOUT = 600                # s
WAIT_AFTER_PAGE_LOAD = 3            # s

DEFAULT_MODELS = [
    "Qwen3.5-0.8B-q4f16_1-MLC",
    "Qwen3.5-2B-q4f16_1-MLC",
    "Qwen3.5-4B-q4f16_1-MLC",
    "Qwen3.5-9B-q4f16_1-MLC",
]

GPU_SAMPLE_INTERVAL = 0.5           # s


# ==================== 本地 HTTP 服务器 ====================

def start_local_server(directory: str, port: int) -> http.server.HTTPServer:
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=directory)
    server = http.server.HTTPServer(("127.0.0.1", port), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    print(f"  本地 HTTP 服务器已启动: http://127.0.0.1:{port}/")
    return server


# ==================== 任务与 URL 映射 ====================

def load_task(task_file: str, task_id: int) -> dict:
    """从 data/<task_file> 中按 task_id 取出单个任务"""
    fp = os.path.join(DATA_DIR, task_file)
    with open(fp, "r", encoding="utf-8") as f:
        tasks = json.load(f)
    for t in tasks:
        if t.get("task_id") == task_id:
            return t
    raise ValueError(f"task_id={task_id} not found in {task_file}")


def load_url_map(url_map_path: str) -> dict[str, str]:
    if not os.path.exists(url_map_path):
        raise FileNotFoundError(
            f"URL 映射文件不存在: {url_map_path}\n请先运行 save_pages.py。"
        )
    with open(url_map_path, "r", encoding="utf-8") as f:
        url_map = json.load(f)
    return {k: v for k, v in url_map.items() if v is not None}


def map_urls_to_local(urls: list[str], url_map: dict[str, str], base_url: str) -> list[str]:
    local_urls = []
    for url in urls:
        filename = url_map.get(url)
        if not filename:
            raise RuntimeError(f"缺少本地 HTML 映射: {url}")
        local_urls.append(f"{base_url}/{filename}")
    return local_urls


# ==================== 浏览器清理 ====================

def clear_browser_startup_data(user_data_dir: str):
    default_dir = os.path.join(user_data_dir, "Default")
    session_paths = [
        os.path.join(default_dir, "Sessions"),
        os.path.join(default_dir, "Current Session"),
        os.path.join(default_dir, "Current Tabs"),
        os.path.join(default_dir, "Last Session"),
        os.path.join(default_dir, "Last Tabs"),
    ]
    sw_cache_paths = [
        os.path.join(default_dir, "Service Worker", "Database"),
        os.path.join(default_dir, "Service Worker", "ScriptCache"),
        os.path.join(default_dir, "Extension State"),
        os.path.join(default_dir, "Extension Rules"),
        os.path.join(default_dir, "Extension Scripts"),
        os.path.join(default_dir, "Code Cache"),
    ]
    for path in session_paths + sw_cache_paths:
        if os.path.isdir(path):
            shutil.rmtree(path, ignore_errors=True)
        elif os.path.isfile(path):
            try:
                os.remove(path)
            except FileNotFoundError:
                pass


# ==================== 扩展 / Sidebar 工具 ====================

async def get_extension_id(context) -> str:
    print("  等待扩展 service worker 注册...")
    for _ in range(30):
        if context.service_workers:
            return context.service_workers[0].url.split("/")[2]
        if context.background_pages:
            return context.background_pages[0].url.split("/")[2]
        await asyncio.sleep(2)
    sw = await context.wait_for_event("serviceworker", timeout=30000)
    return sw.url.split("/")[2]


def get_sidebar_filename(extension_path: str) -> str:
    with open(os.path.join(extension_path, "manifest.json"), "r", encoding="utf-8") as f:
        manifest = json.load(f)
    sidebar_path = manifest.get("side_panel", {}).get("default_path", "")
    if not sidebar_path:
        raise RuntimeError("manifest.json 中未找到 side_panel.default_path")
    return sidebar_path


async def wait_for_engine_ready(sidebar_page, timeout: int = ENGINE_READY_TIMEOUT):
    """等待 submit 按钮可用 ⇒ 引擎就绪"""
    print("  等待引擎就绪...")
    start = time.time()
    await sidebar_page.wait_for_function(
        """() => {
            const btn = document.getElementById('submit-button');
            return btn && !btn.disabled;
        }""",
        timeout=timeout,
    )
    print(f"  引擎就绪 (耗时 {time.time() - start:.1f}s)")


async def change_model(sidebar_page, model_id: str) -> dict:
    """通过扩展消息切换模型，返回 {success, status, ...}"""
    return await sidebar_page.evaluate(
        """(modelId) => new Promise((resolve) => {
              chrome.runtime.sendMessage(
                { type: "CHANGE_MODEL", data: { modelId } },
                (resp) => resolve(resp || { success: false, error: "no response" })
              );
           })""",
        model_id,
    )


async def get_current_model(sidebar_page) -> str | None:
    return await sidebar_page.evaluate(
        """() => new Promise((resolve) => {
              chrome.runtime.sendMessage({ type: "CHECK_ENGINE_STATUS" }, (resp) => {
                resolve(resp?.modelId || null);
              });
           })"""
    )


# ==================== 内容标签页 ====================

async def close_content_tabs(context, sidebar_page):
    for page in context.pages:
        if page != sidebar_page:
            try:
                await page.close()
            except Exception:
                pass


async def open_content_tabs(context, urls: list[str]) -> list:
    pages = []
    for url in urls:
        page = await context.new_page()
        await page.goto(url, timeout=PAGE_LOAD_TIMEOUT, wait_until="domcontentloaded")
        pages.append(page)
    await asyncio.sleep(WAIT_AFTER_PAGE_LOAD)
    return pages


# ==================== 单次推理 (在 sidebar 上下文中) ====================

# 在 sidebar 页面注入一个返回 metrics 的函数：
#   - 自建 `chat_stream` 端口，不依赖 sidebar.ts 的 handleClick
#   - 记录每个 chunk 到达时间 (performance.now())
#   - 在 done 时拿到 usage（含 completion_tokens / prompt_tokens）
INFER_JS = r"""
(intent) => new Promise((resolve, reject) => {
  const port = chrome.runtime.connect({ name: "chat_stream" });
  const chunks = [];           // [{t_ms, len}]
  let answer = "";
  let t_submit = 0;
  let t_first = null;
  let t_last = null;
  let usage = null;
  let done = false;

  port.onMessage.addListener((message) => {
    if (message.type === "chunk") {
      const ch = message.data;
      if (ch.error) {
        port.disconnect();
        reject(new Error(ch.error));
        return;
      }
      if (ch.chunk) {
        const now = performance.now();
        if (t_first === null) t_first = now;
        t_last = now;
        answer += ch.chunk;
        chunks.push({ t_ms: now - t_submit, len: ch.chunk.length });
      }
      if (ch.done) {
        done = true;
        if (ch.usage) usage = ch.usage;
        port.disconnect();
        resolve({
          answer,
          t_submit_perf: t_submit,
          t_first_perf: t_first,
          t_last_perf: t_last,
          ttft_ms: t_first === null ? null : (t_first - t_submit),
          decode_ms: (t_first !== null && t_last !== null) ? (t_last - t_first) : null,
          total_ms: t_last === null ? null : (t_last - t_submit),
          chunk_count: chunks.length,
          char_count: answer.length,
          usage,
        });
      }
    } else if (message.type === "error") {
      port.disconnect();
      reject(new Error(message.error));
    }
  });

  port.onDisconnect.addListener(() => {
    if (!done && chrome.runtime.lastError) {
      reject(new Error(chrome.runtime.lastError.message));
    }
  });

  t_submit = performance.now();
  port.postMessage({
    type: "PROCESS_AND_STREAM",
    userMessage: intent,
    useContext: true,
  });
});
"""


async def run_inference(sidebar_page, intent: str, timeout: int = ANSWER_TIMEOUT) -> dict:
    """在 sidebar 页面上下文跑一次推理并返回 metrics"""
    return await asyncio.wait_for(
        sidebar_page.evaluate(INFER_JS, intent),
        timeout=timeout,
    )


# ==================== GPU / 内存 采样器 ====================

class ResourceSampler:
    """
    采样浏览器进程树 RSS 和（macOS）GPU 利用率/显存。
    Apple Silicon 通过 `ioreg` 读取 IOAccelerator 的统计，无需 sudo。
    其他平台仅采集内存。
    """

    _GPU_UTIL_RE = re.compile(r'"Device Utilization %"\s*=\s*(\d+)')
    _GPU_INUSE_RE = re.compile(r'"In use system memory"\s*=\s*(\d+)')
    _GPU_ALLOC_RE = re.compile(r'"Alloc system memory"\s*=\s*(\d+)')

    def __init__(self, browser_root_pid: int, interval: float = GPU_SAMPLE_INTERVAL):
        self.root_pid = browser_root_pid
        self.interval = interval
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.mem_samples_mb: list[float] = []          # 进程树 RSS 之和(MB)
        self.gpu_util_samples: list[int] = []          # 0-100
        self.gpu_inuse_samples_mb: list[float] = []    # 显存 MB
        self.proc_count_samples: list[int] = []
        self._has_gpu = sys.platform == "darwin" and shutil.which("ioreg") is not None

    def _read_gpu_macos(self) -> tuple[int | None, float | None]:
        try:
            out = subprocess.run(
                ["ioreg", "-r", "-d", "1", "-w", "0", "-c", "IOAccelerator"],
                capture_output=True, text=True, timeout=2,
            ).stdout
        except Exception:
            return (None, None)
        util_vals = [int(m.group(1)) for m in self._GPU_UTIL_RE.finditer(out)]
        inuse_vals = [int(m.group(1)) for m in self._GPU_INUSE_RE.finditer(out)]
        util = max(util_vals) if util_vals else None
        inuse_mb = (max(inuse_vals) / (1024 * 1024)) if inuse_vals else None
        return (util, inuse_mb)

    def _sample_mem(self) -> tuple[float, int]:
        """返回浏览器进程树 RSS 总和(MB) 与进程数"""
        try:
            root = psutil.Process(self.root_pid)
        except psutil.NoSuchProcess:
            return (0.0, 0)
        procs = [root] + root.children(recursive=True)
        total = 0
        alive = 0
        for p in procs:
            try:
                total += p.memory_info().rss
                alive += 1
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
        return (total / (1024 * 1024), alive)

    def _loop(self):
        while not self._stop.is_set():
            mem_mb, n_proc = self._sample_mem()
            self.mem_samples_mb.append(mem_mb)
            self.proc_count_samples.append(n_proc)
            if self._has_gpu:
                util, inuse_mb = self._read_gpu_macos()
                if util is not None:
                    self.gpu_util_samples.append(util)
                if inuse_mb is not None:
                    self.gpu_inuse_samples_mb.append(inuse_mb)
            self._stop.wait(self.interval)

    def start(self):
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def stop(self) -> dict:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=3)
        return self.summary()

    @staticmethod
    def _stats(xs: list[float]) -> dict | None:
        if not xs:
            return None
        return {
            "min": round(min(xs), 2),
            "max": round(max(xs), 2),
            "avg": round(statistics.mean(xs), 2),
            "samples": len(xs),
        }

    def summary(self) -> dict:
        return {
            "mem_mb": self._stats(self.mem_samples_mb),
            "gpu_util_pct": self._stats(self.gpu_util_samples) if self.gpu_util_samples else None,
            "gpu_mem_mb": self._stats(self.gpu_inuse_samples_mb) if self.gpu_inuse_samples_mb else None,
            "proc_count_max": max(self.proc_count_samples) if self.proc_count_samples else None,
            "gpu_supported": self._has_gpu,
        }


def find_browser_root_pid() -> int | None:
    """
    找到 Edge/Chromium 主进程（取最早启动的、parent 不属于该家族的进程）。
    """
    targets = ("Microsoft Edge", "msedge", "Google Chrome", "Chromium", "Chrome")
    candidates = []
    for p in psutil.process_iter(["pid", "name", "ppid", "create_time"]):
        try:
            name = p.info.get("name") or ""
            if any(t.lower() in name.lower() for t in targets):
                candidates.append((p.info["create_time"], p))
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    if not candidates:
        return None
    candidates.sort(key=lambda x: x[0])
    # 选择最早 + 父进程不在同家族的
    for _, p in candidates:
        try:
            parent = p.parent()
            parent_name = parent.name() if parent else ""
        except Exception:
            parent_name = ""
        if not any(t.lower() in parent_name.lower() for t in targets):
            return p.pid
    return candidates[0][1].pid


# ==================== 单个模型基准 ====================

def compute_run_metrics(infer: dict, sampler: dict) -> dict:
    """整理一次 run 的指标"""
    usage = infer.get("usage") or {}
    completion_tokens = usage.get("completion_tokens")
    prompt_tokens = usage.get("prompt_tokens")
    ttft_ms = infer.get("ttft_ms")
    decode_ms = infer.get("decode_ms")
    total_ms = infer.get("total_ms")

    if completion_tokens and completion_tokens > 1 and decode_ms is not None:
        tpot_ms = decode_ms / (completion_tokens - 1)
    elif completion_tokens and completion_tokens >= 1 and decode_ms is not None:
        # 只有 1 个 token：无法计算解码间隔
        tpot_ms = None
    else:
        tpot_ms = None

    return {
        "ttft_s": round(ttft_ms / 1000, 3) if ttft_ms is not None else None,
        "tpot_ms": round(tpot_ms, 2) if tpot_ms is not None else None,
        "decode_s": round(decode_ms / 1000, 3) if decode_ms is not None else None,
        "total_s": round(total_ms / 1000, 3) if total_ms is not None else None,
        "completion_tokens": completion_tokens,
        "prompt_tokens": prompt_tokens,
        "tokens_per_second": (
            round(completion_tokens / (decode_ms / 1000), 2)
            if (completion_tokens and decode_ms and decode_ms > 0)
            else None
        ),
        "chunk_count": infer.get("chunk_count"),
        "char_count": infer.get("char_count"),
        "answer": infer.get("answer", ""),
        "resources": sampler,
    }


def aggregate(runs: list[dict]) -> dict:
    """汇总多次 run 的指标"""
    def _avg(key):
        xs = [r[key] for r in runs if r.get(key) is not None]
        return round(statistics.mean(xs), 3) if xs else None

    def _res_avg(metric, stat="avg"):
        xs = []
        for r in runs:
            v = (r.get("resources") or {}).get(metric)
            if v and v.get(stat) is not None:
                xs.append(v[stat])
        return round(statistics.mean(xs), 2) if xs else None

    def _res_max(metric):
        xs = []
        for r in runs:
            v = (r.get("resources") or {}).get(metric)
            if v and v.get("max") is not None:
                xs.append(v["max"])
        return round(max(xs), 2) if xs else None

    return {
        "n_runs": len(runs),
        "ttft_s_avg": _avg("ttft_s"),
        "tpot_ms_avg": _avg("tpot_ms"),
        "tokens_per_second_avg": _avg("tokens_per_second"),
        "decode_s_avg": _avg("decode_s"),
        "total_s_avg": _avg("total_s"),
        "completion_tokens_avg": _avg("completion_tokens"),
        "prompt_tokens_avg": _avg("prompt_tokens"),
        "mem_mb_avg": _res_avg("mem_mb"),
        "mem_mb_peak": _res_max("mem_mb"),
        "gpu_util_pct_avg": _res_avg("gpu_util_pct"),
        "gpu_util_pct_peak": _res_max("gpu_util_pct"),
        "gpu_mem_mb_avg": _res_avg("gpu_mem_mb"),
        "gpu_mem_mb_peak": _res_max("gpu_mem_mb"),
    }


async def benchmark_model(
    context,
    sidebar_url: str,
    sidebar_page,
    model_id: str,
    intent: str,
    local_urls: list[str],
    repeats: int,
    sampler_root_pid: int | None,
) -> dict:
    """对一个 model_id 跑 repeats 次"""
    print(f"\n{'#' * 60}")
    print(f"# Model: {model_id}")
    print(f"{'#' * 60}")

    # ---- 切换模型 ----
    print(f"  切换模型 -> {model_id}")
    resp = await change_model(sidebar_page, model_id)
    print(f"  CHANGE_MODEL 响应: {resp}")
    if not resp.get("success"):
        return {
            "model_id": model_id,
            "error": f"CHANGE_MODEL failed: {resp.get('error')}",
            "runs": [],
        }
    if resp.get("status") != "same_model":
        # 模型在重新初始化：重新加载 sidebar 等待 submit 可用
        try:
            await sidebar_page.close()
        except Exception:
            pass
        await asyncio.sleep(1)
        sidebar_page = await context.new_page()
        await sidebar_page.goto(sidebar_url, timeout=30000)
        await wait_for_engine_ready(sidebar_page)

    current = await get_current_model(sidebar_page)
    print(f"  当前生效模型: {current}")

    # ---- 打开内容标签页（每个模型只打开一次，所有 runs 共用） ----
    await close_content_tabs(context, sidebar_page)
    for url in local_urls:
        page = await context.new_page()
        await page.goto(url, timeout=PAGE_LOAD_TIMEOUT, wait_until="domcontentloaded")
    await asyncio.sleep(WAIT_AFTER_PAGE_LOAD)

    runs: list[dict] = []
    for i in range(repeats):
        print(f"\n  --- Run {i + 1}/{repeats} ---")

        # 每次 run 重开 sidebar 以保证状态干净
        try:
            await sidebar_page.close()
        except Exception:
            pass
        await asyncio.sleep(1)
        sidebar_page = await context.new_page()
        await sidebar_page.goto(sidebar_url, timeout=30000)
        await wait_for_engine_ready(sidebar_page)
        await sidebar_page.bring_to_front()
        await asyncio.sleep(0.5)

        sampler = ResourceSampler(sampler_root_pid) if sampler_root_pid else None
        if sampler:
            sampler.start()

        try:
            infer = await run_inference(sidebar_page, intent)
        except Exception as e:
            print(f"    推理失败: {e}")
            if sampler:
                sampler.stop()
            runs.append({"error": str(e)})
            continue

        sampler_summary = sampler.stop() if sampler else {}
        run_metrics = compute_run_metrics(infer, sampler_summary)
        run_metrics["run"] = i + 1
        run_metrics["timestamp"] = time.strftime("%Y-%m-%d %H:%M:%S")
        runs.append(run_metrics)

        # 打印摘要
        print(
            f"    TTFT={run_metrics['ttft_s']}s  "
            f"TPOT={run_metrics['tpot_ms']}ms  "
            f"tok={run_metrics['completion_tokens']}  "
            f"tps={run_metrics['tokens_per_second']}  "
            f"MEM(avg/peak MB)={(sampler_summary.get('mem_mb') or {}).get('avg')}/"
            f"{(sampler_summary.get('mem_mb') or {}).get('max')}  "
            f"GPU%(avg/peak)={(sampler_summary.get('gpu_util_pct') or {}).get('avg')}/"
            f"{(sampler_summary.get('gpu_util_pct') or {}).get('max')}"
        )

    return {
        "model_id": model_id,
        "current_model_after_switch": current,
        "runs": runs,
        "aggregate": aggregate([r for r in runs if "error" not in r]),
    }


# ==================== 输出 ====================

def write_per_model_json(out_dir: str, result: dict):
    safe = result["model_id"].replace("/", "_")
    path = os.path.join(out_dir, f"benchmark_{safe}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    print(f"  已写入 {path}")


def write_summary(out_dir: str, all_results: list[dict], meta: dict):
    summary_json = os.path.join(out_dir, "benchmark_summary.json")
    with open(summary_json, "w", encoding="utf-8") as f:
        json.dump(
            {
                "meta": meta,
                "models": [
                    {"model_id": r["model_id"], "aggregate": r.get("aggregate"), "error": r.get("error")}
                    for r in all_results
                ],
            },
            f, indent=2, ensure_ascii=False,
        )

    md = os.path.join(out_dir, "benchmark_summary.md")
    with open(md, "w", encoding="utf-8") as f:
        f.write(f"# WebMast Multi-Model Benchmark\n\n")
        f.write(f"- 任务文件: `{meta['task_file']}` | task_id: `{meta['task_id']}`\n")
        f.write(f"- Intent: {meta['intent']}\n")
        f.write(f"- 重复次数: {meta['repeats']}\n")
        f.write(f"- 时间: {meta['timestamp']}\n\n")
        cols = [
            "model_id", "ttft_s_avg", "tpot_ms_avg", "tokens_per_second_avg",
            "completion_tokens_avg", "mem_mb_avg", "mem_mb_peak",
            "gpu_util_pct_avg", "gpu_util_pct_peak", "gpu_mem_mb_peak",
        ]
        f.write("| " + " | ".join(cols) + " |\n")
        f.write("| " + " | ".join("---" for _ in cols) + " |\n")
        for r in all_results:
            if r.get("error"):
                f.write(f"| {r['model_id']} | ERROR: {r['error']} |\n")
                continue
            agg = r.get("aggregate") or {}
            row = [r["model_id"]] + [str(agg.get(c)) for c in cols[1:]]
            f.write("| " + " | ".join(row) + " |\n")
    print(f"  已写入 {summary_json}")
    print(f"  已写入 {md}")


# ==================== Main ====================

async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", nargs="+", default=DEFAULT_MODELS,
                        help="待测模型 ID 列表（web-llm prebuilt 或自定义注册的 model_id）")
    parser.add_argument("--repeats", type=int, default=3, help="每个模型重复次数")
    parser.add_argument("--task-file", default="gitlab.json", help="data/ 下的任务 JSON")
    parser.add_argument("--task-id", type=int, default=0, help="选择的 task_id")
    parser.add_argument("--output-dir", default=OUTPUT_DIR)
    parser.add_argument("--headed", action="store_true", help="显示浏览器窗口（默认 headless）")
    args = parser.parse_args()

    os.makedirs(args.output_dir, exist_ok=True)

    # ---- 任务 & URL 映射 ----
    task = load_task(args.task_file, args.task_id)
    intent = task["intent"]
    open_urls = task["open_url"]
    print(f"任务: {args.task_file} task_id={args.task_id}")
    print(f"Intent: {intent}")

    url_map = load_url_map(URL_MAP_PATH)
    local_base = f"http://127.0.0.1:{LOCAL_SERVER_PORT}"
    local_urls = map_urls_to_local(open_urls, url_map, local_base)

    # ---- 启动 HTTP 服务器 ----
    server = start_local_server(HTML_DIR, LOCAL_SERVER_PORT)

    sidebar_filename = get_sidebar_filename(EXTENSION_PATH)

    all_results: list[dict] = []

    async with async_playwright() as p:
        print("\n启动 Edge 浏览器...")
        os.makedirs(USER_DATA_DIR, exist_ok=True)
        clear_browser_startup_data(USER_DATA_DIR)

        launch_args = [
            f"--disable-extensions-except={EXTENSION_PATH}",
            f"--load-extension={EXTENSION_PATH}",
            "--lang=en-US",
        ]
        if not args.headed:
            launch_args.insert(0, "--headless=new")

        context = await p.chromium.launch_persistent_context(
            user_data_dir=USER_DATA_DIR,
            channel="msedge",
            headless=False,
            locale="en-US",
            args=launch_args,
            timeout=60000,
            viewport={"width": 1280, "height": 900},
        )

        try:
            ext_id = await get_extension_id(context)
            sidebar_url = f"chrome-extension://{ext_id}/{sidebar_filename}"
            print(f"Sidebar URL: {sidebar_url}")

            for page in context.pages:
                try:
                    await page.close()
                except Exception:
                    pass

            sidebar_page = await context.new_page()
            await sidebar_page.goto(sidebar_url, timeout=30000)
            await wait_for_engine_ready(sidebar_page)

            sampler_root_pid = find_browser_root_pid()
            print(f"浏览器主进程 PID: {sampler_root_pid}")

            for model_id in args.models:
                try:
                    result = await benchmark_model(
                        context=context,
                        sidebar_url=sidebar_url,
                        sidebar_page=sidebar_page,
                        model_id=model_id,
                        intent=intent,
                        local_urls=local_urls,
                        repeats=args.repeats,
                        sampler_root_pid=sampler_root_pid,
                    )
                except Exception as e:
                    result = {"model_id": model_id, "error": str(e), "runs": []}
                all_results.append(result)
                write_per_model_json(args.output_dir, result)
                # 切换模型后 sidebar 已被重开，下一轮循环开头会再 evaluate；
                # 这里同步取最新的 sidebar 页面（最后一个非内容页）
                for pg in context.pages:
                    if pg.url.startswith("chrome-extension://"):
                        sidebar_page = pg

            write_summary(
                args.output_dir,
                all_results,
                meta={
                    "task_file": args.task_file,
                    "task_id": args.task_id,
                    "intent": intent,
                    "repeats": args.repeats,
                    "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
                    "host": sys.platform,
                },
            )

        except KeyboardInterrupt:
            print("\n用户中断，保存当前结果...")
            if all_results:
                write_summary(
                    args.output_dir, all_results,
                    meta={
                        "task_file": args.task_file, "task_id": args.task_id,
                        "intent": intent, "repeats": args.repeats,
                        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
                        "host": sys.platform, "interrupted": True,
                    },
                )
        finally:
            try:
                await context.close()
            except Exception:
                pass
            server.shutdown()


if __name__ == "__main__":
    asyncio.run(main())
