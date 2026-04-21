"""
WebMast Extension Local-HTML Testing Script
=============================================
基于 run_test.py 改写，使用本地 HTML 文件（由 save_pages.py 生成）
替代原始远程网页进行测试。

工作流程：
1. 启动本地 HTTP 服务器，提供 files/html/ 中的 HTML 文件
2. 启动 Edge 浏览器（加载 WebMast 扩展）
3. 对每个任务，打开 *本地* HTML 页面（内容与原始网页 innerText 一致）
4. 在 WebMast 侧边栏输入 intent，等待回复，记录 answer 和 TTFT
5. 每个任务重复 3 次
6. 将所有运行结果记录到 JSON 文件中

前置条件：
    先运行 save_pages.py 生成本地 HTML 文件和 url_map.json

使用方式:
    pip install playwright
    playwright install chromium
    python scripts/run_test_local.py

注意：
    - 需要先运行 save_pages.py 抓取网页内容
    - 首次运行时 WebMast 需要下载模型，可能需要几分钟
    - 使用持久化浏览器 profile，登录状态会被保留
"""

import json
import asyncio
import time
import re
import os
import sys
import shutil
import threading
import http.server
import functools
from pathlib import Path
from playwright.async_api import async_playwright

# ==================== 配置 ====================

SCRIPT_DIR = Path(__file__).parent.resolve()
PROJECT_DIR = SCRIPT_DIR.parent  # WebMast/

EXTENSION_PATH = str(PROJECT_DIR / "dist")
DATA_DIR = str(PROJECT_DIR.parent / "Master-Thesis" / "data")
OUTPUT_DIR = str(PROJECT_DIR.parent / "Master-Thesis" / "data")
USER_DATA_DIR = str(PROJECT_DIR / "test-profile")

HTML_DIR = str(PROJECT_DIR / "files" / "html")
URL_MAP_PATH = os.path.join(HTML_DIR, "url_map.json")
LOCAL_SERVER_PORT = 8765          # 本地 HTTP 服务器端口

TASK_JSON_FILES = ["gitlab.json", "map.json", "reddit.json",  "wiki.json"]

REPEAT_COUNT = 3                  # 每个任务重复次数
PAGE_LOAD_TIMEOUT = 60000         # 页面加载超时 (ms)
ENGINE_READY_TIMEOUT = 1200000    # 引擎加载超时 (ms), 首次下载模型较慢
ANSWER_TIMEOUT = 120              # 等待回答超时 (秒)
ANSWER_STABLE_SECONDS = 5         # 回答内容稳定多少秒视为完成
WAIT_AFTER_PAGE_LOAD = 3          # 页面加载后等待 content script 注入的秒数
BACKGROUND_TS_PATH = str(PROJECT_DIR / "src" / "background.ts")


# ==================== 本地 HTTP 服务器 ====================

def start_local_server(directory: str, port: int) -> http.server.HTTPServer:
    """在后台线程启动一个本地 HTTP 服务器，用于提供 HTML 文件"""
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=directory)
    server = http.server.HTTPServer(("127.0.0.1", port), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    print(f"  本地 HTTP 服务器已启动: http://127.0.0.1:{port}/")
    return server


# ==================== 数据加载 ====================

def load_tasks_from_data_dir(data_dir: str) -> list[dict]:
    """从 data 目录下所有任务 JSON 文件加载并合并任务列表"""
    all_tasks = []
    for filename in TASK_JSON_FILES:
        filepath = os.path.join(data_dir, filename)
        if not os.path.exists(filepath):
            print(f"  跳过不存在的文件: {filename}")
            continue
        with open(filepath, "r", encoding="utf-8") as f:
            tasks = json.load(f)
        all_tasks.extend(tasks)
        print(f"  {filename}: {len(tasks)} 个任务")
    # 按 task_id 排序
    all_tasks.sort(key=lambda t: t.get("task_id", 0))
    return all_tasks


def load_url_map(url_map_path: str) -> dict[str, str]:
    """加载 URL → 本地文件名映射"""
    if not os.path.exists(url_map_path):
        raise FileNotFoundError(
            f"URL 映射文件不存在: {url_map_path}\n"
            "请先运行 save_pages.py 生成本地 HTML 文件。"
        )
    with open(url_map_path, "r", encoding="utf-8") as f:
        url_map = json.load(f)
    # 过滤掉失败的映射 (值为 None)
    valid = {k: v for k, v in url_map.items() if v is not None}
    print(f"  已加载 {len(valid)}/{len(url_map)} 个有效 URL 映射")
    return valid


def map_urls_to_local(
    urls: list[str], url_map: dict[str, str], base_url: str
) -> list[str] | None:
    """
    将原始 URL 列表映射为本地 URL 列表。
    如果任何 URL 缺少映射，返回 None。
    """
    local_urls = []
    for url in urls:
        filename = url_map.get(url)
        if not filename:
            print(f"    缺少本地文件映射: {url[:80]}...")
            return None
        local_urls.append(f"{base_url}/{filename}")
    return local_urls


# ==================== 浏览器工具函数（与 run_test.py 相同） ====================

def clear_browser_startup_data(user_data_dir: str):
    """统一清理会话恢复数据和扩展相关缓存。"""
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

    for path in session_paths:
        if os.path.isdir(path):
            print(f"  清理会话目录: {os.path.relpath(path, user_data_dir)}/")
            shutil.rmtree(path, ignore_errors=True)
        elif os.path.isfile(path):
            print(f"  清理会话文件: {os.path.relpath(path, user_data_dir)}")
            try:
                os.remove(path)
            except FileNotFoundError:
                pass

    for path in sw_cache_paths:
        if os.path.isdir(path):
            print(f"  清除缓存: {os.path.relpath(path, user_data_dir)}/")
            shutil.rmtree(path, ignore_errors=True)


def parse_background_constants() -> dict:
    """从 background.ts 中解析 DEFAULT_MODEL_ID 和 DATA_FLOW_TYPE"""
    result = {"model_id": "unknown", "workflow_type": "unknown"}
    try:
        with open(BACKGROUND_TS_PATH, "r", encoding="utf-8") as f:
            content = f.read()
        m = re.search(r'const\s+DEFAULT_MODEL_ID\s*=\s*"([^"]+)"', content)
        if m:
            result["model_id"] = m.group(1)
        m = re.search(r'const\s+DATA_FLOW_TYPE\s*:\s*number\s*=\s*(\d+)', content)
        if m:
            result["workflow_type"] = int(m.group(1))
    except Exception as e:
        print(f"  警告: 无法解析 background.ts 常量: {e}")
    return result


async def get_extension_id(context) -> str:
    """从 service worker 或 background page 获取扩展 ID"""
    print("  等待扩展 service worker 注册...")
    for attempt in range(30):
        if context.service_workers:
            sw = context.service_workers[0]
            ext_id = sw.url.split("/")[2]
            print(f"  扩展 ID (service worker): {ext_id}")
            return ext_id
        if context.background_pages:
            bg = context.background_pages[0]
            ext_id = bg.url.split("/")[2]
            print(f"  扩展 ID (background page): {ext_id}")
            return ext_id
        await asyncio.sleep(2)

    print("  轮询未找到，等待 serviceworker 事件...")
    sw = await context.wait_for_event("serviceworker", timeout=30000)
    ext_id = sw.url.split("/")[2]
    print(f"  扩展 ID: {ext_id}")
    return ext_id


def get_sidebar_filename(extension_path: str) -> str:
    """从 dist/manifest.json 读取 sidebar 文件名"""
    manifest_path = os.path.join(extension_path, "manifest.json")
    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)
    sidebar_path = manifest.get("side_panel", {}).get("default_path", "")
    if not sidebar_path:
        raise RuntimeError("manifest.json 中未找到 side_panel.default_path")
    return sidebar_path


async def wait_for_engine_ready(sidebar_page, timeout=ENGINE_READY_TIMEOUT):
    """等待 WebMast 引擎加载就绪（submit 按钮可用）"""
    print("  等待引擎加载...")
    start = time.time()

    await sidebar_page.wait_for_function(
        """() => {
            const btn = document.getElementById('submit-button');
            return btn && !btn.disabled;
        }""",
        timeout=timeout,
    )

    elapsed = time.time() - start
    print(f"  引擎就绪 (耗时 {elapsed:.1f}s)")


async def submit_query(sidebar_page, intent: str):
    """在 WebMast 输入框中输入 intent 并提交"""
    input_el = sidebar_page.locator("#query-input")
    await input_el.fill("")
    await input_el.fill(intent)

    await input_el.dispatch_event("keyup")

    await sidebar_page.wait_for_function(
        """() => {
            const btn = document.getElementById('submit-button');
            return btn && !btn.disabled;
        }""",
        timeout=10000,
    )

    submit_btn = sidebar_page.locator("#submit-button")
    await submit_btn.click()


async def wait_for_answer(sidebar_page, timeout=ANSWER_TIMEOUT) -> tuple[str, str]:
    """
    等待 WebMast 回答完成。
    返回 (answer_text, ttft_seconds)
    """
    start = time.time()

    try:
        await sidebar_page.wait_for_function(
            """() => {
                const el = document.getElementById('answer');
                return el && el.innerText && el.innerText.trim().length > 0;
            }""",
            timeout=timeout * 1000,
        )
    except Exception as e:
        print(f"    等待首个回答超时: {e}")
        answer = await sidebar_page.evaluate(
            "document.getElementById('answer')?.innerText || ''"
        )
        return (answer.strip() or "timeout", "N/A")

    ttft_text = await sidebar_page.text_content("#elapsed-timer") or ""
    ttft_match = re.search(r"([\d.]+)\s*s", ttft_text)
    ttft = ttft_match.group(1) if ttft_match else "N/A"

    last_answer = ""
    stable_start = None

    while True:
        elapsed = time.time() - start
        if elapsed > timeout:
            print(f"    回答超时 ({timeout}s)")
            break

        current = await sidebar_page.evaluate(
            "document.getElementById('answer')?.innerText || ''"
        )
        current = current.strip()

        if current and current == last_answer:
            if stable_start is None:
                stable_start = time.time()
            elif time.time() - stable_start >= ANSWER_STABLE_SECONDS:
                break
        else:
            stable_start = None
            last_answer = current

        await asyncio.sleep(0.5)

    final_answer = await sidebar_page.evaluate(
        "document.getElementById('answer')?.innerText || ''"
    )
    ttft_text_final = await sidebar_page.text_content("#elapsed-timer") or ""
    ttft_match_final = re.search(r"([\d.]+)\s*s", ttft_text_final)
    if ttft_match_final:
        ttft = ttft_match_final.group(1)

    return (final_answer.strip(), ttft)


async def close_content_tabs(context, sidebar_page):
    """关闭所有标签页，只保留 sidebar 页面"""
    for page in context.pages:
        if page != sidebar_page:
            try:
                await page.close()
            except Exception:
                pass


async def open_content_tabs(context, urls: list[str]) -> list:
    """
    依次打开 URL 标签页，返回页面列表。
    如果任何 URL 加载失败，抛出 RuntimeError。
    """
    pages = []

    for url in urls:
        page = await context.new_page()
        try:
            await page.goto(url, timeout=PAGE_LOAD_TIMEOUT, wait_until="domcontentloaded")
            print(f"    已打开: {url[:100]}...")
        except Exception as e:
            print(f"    页面加载失败 ({url[:80]}...): {type(e).__name__}")
            raise RuntimeError(f"URL 加载失败: {url[:80]}...")
        pages.append(page)

    # 等待 content script 注入和页面处理
    await asyncio.sleep(WAIT_AFTER_PAGE_LOAD)

    return pages


# ==================== 主流程 ====================

async def main():
    # 加载任务数据（从各分类 JSON 文件合并）
    print("加载任务数据...")
    tasks = load_tasks_from_data_dir(DATA_DIR)
    print(f"共加载 {len(tasks)} 个任务\n")

    # 加载 URL 映射
    print("加载 URL 映射...")
    url_map = load_url_map(URL_MAP_PATH)
    local_base_url = f"http://127.0.0.1:{LOCAL_SERVER_PORT}"

    # 解析 background.ts 中的常量
    bg_constants = parse_background_constants()
    model_short = bg_constants["model_id"]
    wf_type = bg_constants["workflow_type"]
    OUTPUT_PATH = os.path.join(OUTPUT_DIR, f"local_{model_short}_wf{wf_type}_headless.json")
    print(f"Model ID: {bg_constants['model_id']}, Workflow Type: {wf_type}")
    print(f"输出文件: {OUTPUT_PATH}")

    # 获取 sidebar 文件名
    sidebar_filename = get_sidebar_filename(EXTENSION_PATH)
    print(f"Sidebar 文件: {sidebar_filename}")

    # 启动本地 HTTP 服务器
    print("\n启动本地 HTTP 服务器...")
    server = start_local_server(HTML_DIR, LOCAL_SERVER_PORT)

    # 如果有之前中断的结果，加载它
    existing_results = []
    completed_task_ids = set()
    if os.path.exists(OUTPUT_PATH):
        try:
            with open(OUTPUT_PATH, "r", encoding="utf-8") as f:
                existing_results = json.load(f)
            completed_task_ids = {
                r["task_id"]
                for r in existing_results
                if len(r.get("runs", [])) >= REPEAT_COUNT
            }
            if completed_task_ids:
                print(f"发现已完成的任务: {len(completed_task_ids)} 个，将跳过")
        except Exception:
            existing_results = []

    results = list(existing_results)

    async with async_playwright() as p:
        # 启动 Edge 浏览器（加载 WebMast 扩展）
        print("\n启动 Edge 浏览器...")
        os.makedirs(USER_DATA_DIR, exist_ok=True)

        clear_browser_startup_data(USER_DATA_DIR)

        context = await p.chromium.launch_persistent_context(
            user_data_dir=USER_DATA_DIR,
            channel="msedge",
            headless=False,
            args=[
                # "--headless=new",
                f"--disable-extensions-except={EXTENSION_PATH}",
                f"--load-extension={EXTENSION_PATH}",
            ],
            timeout=60000,
            viewport={"width": 1280, "height": 900},
        )

        try:
            # 获取扩展 ID
            ext_id = await get_extension_id(context)
            sidebar_url = f"chrome-extension://{ext_id}/{sidebar_filename}"

            # 关闭默认页面
            for page in context.pages:
                try:
                    await page.close()
                except Exception:
                    pass

            # 打开 sidebar 页面（作为一个标签页）
            print(f"\n打开 WebMast sidebar: {sidebar_url}")
            sidebar_page = await context.new_page()
            await sidebar_page.goto(sidebar_url, timeout=30000)

            # 等待引擎就绪
            await wait_for_engine_ready(sidebar_page)

            # ==================== 遍历所有任务 ====================
            for task_idx, task in enumerate(tasks):
                task_id = task["task_id"]
                intent = task["intent"]
                open_urls = task["open_url"]

                # 跳过已完成的任务
                if task_id in completed_task_ids:
                    print(f"\n[{task_idx+1}/{len(tasks)}] Task {task_id} 已完成，跳过")
                    continue

                # 将原始 URL 映射为本地 URL
                local_urls = map_urls_to_local(open_urls, url_map, local_base_url)
                if local_urls is None:
                    print(f"  跳过任务 {task_id}：部分 URL 缺少本地文件映射")
                    continue

                print(f"\n{'=' * 60}")
                print(f"[{task_idx+1}/{len(tasks)}] Task ID: {task_id}")
                print(f"  Intent: {intent}")
                print(f"  URLs: {len(open_urls)} 个 (本地)")

                task_result = {
                    "task_id": task_id,
                    "runs": [],
                }

                # ---- 打开所有内容标签页（使用本地 URL）----

                # 先关闭旧的内容标签页
                await close_content_tabs(context, sidebar_page)

                # 打开新内容标签页（最多重试 3 次）
                content_pages = None
                for open_attempt in range(3):
                    try:
                        content_pages = await open_content_tabs(context, local_urls)
                        if len(content_pages) != len(local_urls):
                            raise RuntimeError(
                                f"标签页数量不匹配: 期望 {len(local_urls)}，实际 {len(content_pages)}"
                            )
                        break
                    except Exception as e:
                        print(f"  打开标签页失败 (尝试 {open_attempt+1}/3): {e}")
                        await close_content_tabs(context, sidebar_page)
                        content_pages = None
                        if open_attempt < 2:
                            await asyncio.sleep(2)

                if not content_pages or len(content_pages) != len(local_urls):
                    print(f"  跳过任务 {task_id}：3 次重试后仍无法打开所有标签页")
                    continue

                # ---- 重复提交 3 次 ----
                for run_idx in range(REPEAT_COUNT):
                    print(f"\n  --- Run {run_idx+1}/{REPEAT_COUNT} ---")

                    # 每次 run 都关闭并重新打开 sidebar，确保状态干净
                    try:
                        await asyncio.sleep(2)
                        await sidebar_page.close()
                        await asyncio.sleep(1)
                    except Exception:
                        pass
                    print(f"    重新打开 sidebar...")
                    sidebar_page = await context.new_page()
                    await sidebar_page.goto(sidebar_url, timeout=30000)
                    await wait_for_engine_ready(sidebar_page)
                    await asyncio.sleep(1)

                    # 聚焦到 sidebar 页面
                    await sidebar_page.bring_to_front()
                    await asyncio.sleep(0.5)

                    # 提交查询
                    print(f"    提交 intent...")
                    await submit_query(sidebar_page, intent)

                    # 等待回答
                    print(f"    等待回答...")
                    answer, ttft = await wait_for_answer(sidebar_page)

                    run_result = {
                        "run": run_idx + 1,
                        "answer": answer,
                        "ttft": ttft,
                        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
                    }
                    task_result["runs"].append(run_result)

                    # 打印结果摘要
                    answer_preview = answer[:100] + ("..." if len(answer) > 100 else "")
                    print(f"    TTFT: {ttft}s")
                    print(f"    Answer: {answer_preview}")

                results.append(task_result)

                # 每完成一个任务就保存中间结果（防止中断丢失）
                with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
                    json.dump(results, f, indent=2, ensure_ascii=False)
                print(f"\n  已保存中间结果 ({len(results)} 个任务)")

            # ==================== 完成 ====================
            print(f"\n{'=' * 60}")
            print(f"全部 {len(tasks)} 个任务完成！")
            print(f"结果已保存至: {OUTPUT_PATH}")

        except KeyboardInterrupt:
            print("\n\n用户中断，保存当前结果...")
            with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
                json.dump(results, f, indent=2, ensure_ascii=False)
            print(f"已保存 {len(results)} 个任务的结果到 {OUTPUT_PATH}")
        except Exception as e:
            print(f"\n错误: {e}")
            if results:
                with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
                    json.dump(results, f, indent=2, ensure_ascii=False)
                print(f"已保存 {len(results)} 个任务的结果到 {OUTPUT_PATH}")
            raise
        finally:
            await context.close()
            server.shutdown()
            print("  本地 HTTP 服务器已关闭")


if __name__ == "__main__":
    asyncio.run(main())
