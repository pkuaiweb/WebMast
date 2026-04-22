"""
WebMast Summary Pre-Cache Script
==================================
预缓存脚本：为所有 URL 生成摘要缓存，以加速后续测试。

支持两种模式：
  local  - 打开本地 HTML 文件（通过本地 HTTP 服务器），进行预缓存
  remote - 读取 Master-Thesis/data/ 中的任务 JSON，提取并去重所有 URL，
           逐一打开远程网页，调用 WebMast 进行摘要缓存

流程：
1. 启动 Edge 浏览器（加载 WebMast 扩展）
2. 等待 LLM 引擎就绪
3. 根据模式收集 URL 列表
4. 对每个 URL：
   a. 通过扩展检查 chrome.storage.local 中是否已有摘要缓存
   b. 如果有，跳过
   c. 如果没有，打开该 URL，等待 content.js 触发 PAGE_LOADED，
      background.ts 自动调用 summarizePage() 生成摘要并保存到 chrome.storage.local
   d. 轮询等待摘要生成完成
   e. 关闭当前网页
5. 将所有摘要按 SUMMARY_CACHE_PREFIX + url : SummaryData 格式导出到 summary_cache.json

使用方式:
    pip install playwright
    playwright install chromium

    # 本地 HTML 模式（默认）
    python scripts/precache_summaries.py
    python scripts/precache_summaries.py --mode local

    # 远程 URL 模式
    python scripts/precache_summaries.py --mode remote

注意：
    - 首次运行时 WebMast 需要下载模型，可能需要几分钟
    - 使用持久化浏览器 profile (test-profile/)，缓存会保留
    - 生成的 chrome.storage.local 缓存在 test-profile/ 中持久化，
      后续 run_v5_test.py 启动时可直接利用
    - remote 模式需要远程服务器可达
"""

import argparse
import asyncio
import json
import os
import re
import shutil
import time
import threading
import http.server
import functools
from pathlib import Path
from playwright.async_api import async_playwright

# ==================== 配置 ====================

SCRIPT_DIR = Path(__file__).parent.resolve()
PROJECT_DIR = SCRIPT_DIR.parent  # WebMast/

EXTENSION_PATH = str(PROJECT_DIR / "dist")
SUMMARY_CACHE_JSON_PATH = str(PROJECT_DIR  / "files" / "summary_cache.json")
USER_DATA_DIR = str(PROJECT_DIR / "test-profile")
BACKGROUND_TS_PATH = str(PROJECT_DIR / "src" / "background.ts")

HTML_DIR = str(PROJECT_DIR / "files" / "html")
LOCAL_SERVER_PORT = 8765          # 本地 HTTP 服务器端口

# remote 模式：任务 JSON 所在目录
DATA_DIR = str(PROJECT_DIR.parent / "Master-Thesis" / "data")
TASK_JSON_FILES = ["gitlab.json", "map.json", "reddit.json", "shopping.json", "wiki.json"]

PAGE_LOAD_TIMEOUT = 60000          # 页面加载超时 (ms)
ENGINE_READY_TIMEOUT = 1200000     # 引擎加载超时 (ms), 首次下载模型较慢
SUMMARY_TIMEOUT = 180              # 等待单个摘要生成超时 (秒)
WAIT_AFTER_PAGE_LOAD = 10          # 页面加载后等待 content script 注入 + PAGE_LOADED 发送的秒数
SUMMARY_CACHE_PREFIX = "page_summary_"
NEED_LOGIN = False


# ==================== 本地 HTTP 服务器 ====================

def start_local_server(directory: str, port: int) -> http.server.HTTPServer:
    """在后台线程启动一个本地 HTTP 服务器，用于提供 HTML 文件"""
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=directory)
    server = http.server.HTTPServer(("127.0.0.1", port), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    print(f"  本地 HTTP 服务器已启动: http://127.0.0.1:{port}/")
    return server


def collect_html_files(html_dir: str) -> list[str]:
    """扫描 HTML 目录，返回所有 .html 文件名（排序）"""
    files = sorted(
        f for f in os.listdir(html_dir)
        if f.endswith(".html")
    )
    print(f"  找到 {len(files)} 个 HTML 文件")
    return files


def collect_remote_urls(data_dir: str, task_files: list[str]) -> list[str]:
    """从 data/ 目录的任务 JSON 文件中提取所有唯一 URL（保持首次出现顺序）"""
    seen = set()
    urls = []
    for filename in task_files:
        filepath = os.path.join(data_dir, filename)
        if not os.path.exists(filepath):
            print(f"  警告: 文件不存在，跳过: {filepath}")
            continue
        with open(filepath, "r", encoding="utf-8") as f:
            tasks = json.load(f)
        file_count = 0
        for task in tasks:
            # 收集 open_url 列表中的所有 URL
            for url in task.get("open_url", []):
                if url not in seen:
                    seen.add(url)
                    urls.append(url)
                    file_count += 1
            # 收集 start_url
            start_url = task.get("start_url", "")
            if start_url and start_url not in seen:
                seen.add(start_url)
                urls.append(start_url)
                file_count += 1
        print(f"  {filename}: 新增 {file_count} 个唯一 URL")
    print(f"  共提取 {len(urls)} 个唯一 URL（来自 {len(task_files)} 个文件）")
    return urls


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


# ==================== 工具函数 ====================

def load_existing_cache(path: str) -> dict:
    """加载已有的 summary_cache.json"""
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                content = f.read().strip()
                if content:
                    return json.loads(content)
        except Exception as e:
            print(f"  警告: 加载 summary_cache.json 失败: {e}")
    return {}


def save_cache_json(path: str, cache: dict):
    """保存 summary_cache.json"""
    with open(path, "w", encoding="utf-8") as f:
        json.dump(cache, f, indent=2, ensure_ascii=False)


def get_sidebar_filename(extension_path: str) -> str:
    """从 dist/manifest.json 读取 sidebar 文件名"""
    manifest_path = os.path.join(extension_path, "manifest.json")
    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)
    sidebar_path = manifest.get("side_panel", {}).get("default_path", "")
    if not sidebar_path:
        raise RuntimeError("manifest.json 中未找到 side_panel.default_path")
    return sidebar_path


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


async def check_cached_summary(sidebar_page, url: str) -> dict | None:
    """
    通过 sidebar 页面检查 chrome.storage.local 中是否已有摘要缓存。
    返回 SummaryData 或 None。
    """
    result = await sidebar_page.evaluate(
        """async (url) => {
            return new Promise((resolve) => {
                chrome.runtime.sendMessage(
                    {type: "GET_CACHED_SUMMARY", data: {url: url}},
                    (response) => {
                        if (chrome.runtime.lastError) {
                            resolve(null);
                        } else {
                            resolve(response?.summary || null);
                        }
                    }
                );
            });
        }""",
        url,
    )
    return result


async def get_all_cached_summaries(sidebar_page) -> dict:
    """
    通过 sidebar 页面获取 chrome.storage.local 中所有摘要缓存。
    返回 {url: SummaryData} 字典。
    """
    result = await sidebar_page.evaluate(
        """async () => {
            return new Promise((resolve) => {
                chrome.runtime.sendMessage(
                    {type: "GET_ALL_CACHED_SUMMARIES"},
                    (response) => {
                        if (chrome.runtime.lastError) {
                            resolve({});
                        } else {
                            resolve(response?.summaries || {});
                        }
                    }
                );
            });
        }"""
    )
    return result or {}


async def wait_for_summary_cached(sidebar_page, url: str, timeout: int = SUMMARY_TIMEOUT) -> dict | None:
    """
    轮询等待指定 URL 的摘要缓存生成完成。
    返回 SummaryData 或 None（超时）。
    """
    start = time.time()
    while time.time() - start < timeout:
        cached = await check_cached_summary(sidebar_page, url)
        if cached:
            return cached
        await asyncio.sleep(2)  # 每 2 秒检查一次
    return None


async def handle_login_if_needed(context):
    return
    """首次运行时暂停让用户手动登录"""
    if not NEED_LOGIN:
        return

    login_marker = os.path.join(USER_DATA_DIR, ".login_done")
    if os.path.exists(login_marker):
        print("  已检测到登录标记，跳过登录步骤")
        return

    page = await context.new_page()
    login_url = "http://ec2-18-118-167-74.us-east-2.compute.amazonaws.com:7770/customer/account/login/"
    try:
        await page.goto(login_url, timeout=PAGE_LOAD_TIMEOUT, wait_until="domcontentloaded")
    except Exception:
        print(f"  无法打开登录页面，可能网站不可达: {login_url}")
        await page.close()
        return

    print("\n" + "=" * 60)
    print("请在浏览器中手动登录网站")
    print("登录完成后，回到终端按 Enter 继续...")
    print("=" * 60)

    await asyncio.get_event_loop().run_in_executor(None, input)

    os.makedirs(USER_DATA_DIR, exist_ok=True)
    with open(login_marker, "w") as f:
        f.write("logged in")
    print("  登录标记已保存")

    await page.close()


# ==================== 主流程 ====================

def parse_args():
    parser = argparse.ArgumentParser(description="WebMast Summary Pre-Cache Script")
    parser.add_argument(
        "--mode", choices=["local", "remote"], default="local",
        help="预缓存模式: local=本地 HTML 文件, remote=远程 URL (默认: local)"
    )
    return parser.parse_args()


async def main():
    args = parse_args()
    mode = args.mode
    print(f"预缓存模式: {mode}")

    server = None  # 本地 HTTP 服务器（仅 local 模式使用）

    if mode == "local":
        # ===== local 模式：扫描本地 HTML 文件 =====
        print("\n扫描 HTML 文件...")
        html_files = collect_html_files(HTML_DIR)
        if not html_files:
            print("没有找到 HTML 文件，退出")
            return
        local_base_url = f"http://127.0.0.1:{LOCAL_SERVER_PORT}"
        url_list = [f"{local_base_url}/{f}" for f in html_files]
        display_names = html_files  # 用于打印的可读名称

        # 启动本地 HTTP 服务器
        print("\n启动本地 HTTP 服务器...")
        server = start_local_server(HTML_DIR, LOCAL_SERVER_PORT)

    else:
        # ===== remote 模式：从 data/ JSON 文件收集 URL =====
        print(f"\n从 {DATA_DIR} 收集远程 URL...")
        url_list = collect_remote_urls(DATA_DIR, TASK_JSON_FILES)
        if not url_list:
            print("没有找到 URL，退出")
            return
        display_names = url_list  # 远程模式直接显示 URL

    # 加载已有的 summary_cache.json
    cache_json = load_existing_cache(SUMMARY_CACHE_JSON_PATH)
    print(f"summary_cache.json 中已有 {len(cache_json)} 条缓存")

    # 获取 sidebar 文件名
    sidebar_filename = get_sidebar_filename(EXTENSION_PATH)
    print(f"Sidebar 文件: {sidebar_filename}")

    async with async_playwright() as p:
        # 启动 Edge 浏览器（加载 WebMast 扩展）
        print("\n启动 Edge 浏览器...")
        os.makedirs(USER_DATA_DIR, exist_ok=True)

        # 统一清理会话恢复数据和扩展缓存，防止旧会话/旧 SW 残留影响预缓存
        # 注意：保留 CacheStorage（WebLLM 模型权重缓存在这里）
        clear_browser_startup_data(USER_DATA_DIR)

        context = await p.chromium.launch_persistent_context(
            user_data_dir=USER_DATA_DIR,
            channel="msedge",
            headless=False,
            locale="en-US",
            args=[
                "--headless=new",
                f"--disable-extensions-except={EXTENSION_PATH}",
                f"--load-extension={EXTENSION_PATH}",
                "--lang=en-US",
            ],
            timeout=60000,
            viewport={"width": 1280, "height": 900},
        )

        try:
            # 获取扩展 ID
            ext_id = await get_extension_id(context)
            sidebar_url = f"chrome-extension://{ext_id}/{sidebar_filename}"

            # 处理登录
            await handle_login_if_needed(context)

            # 关闭默认页面
            for page in context.pages:
                try:
                    await page.close()
                except Exception:
                    pass

            # 打开 sidebar 页面
            print(f"\n打开 WebMast sidebar: {sidebar_url}")
            sidebar_page = await context.new_page()
            await sidebar_page.goto(sidebar_url, timeout=30000)

            # 等待引擎就绪
            await wait_for_engine_ready(sidebar_page)

            # ==================== 预缓存所有 URL ====================
            cached_count = 0
            generated_count = 0
            failed_count = 0

            for idx, url in enumerate(url_list):
                display = display_names[idx]
                print(f"\n[{idx + 1}/{len(url_list)}] {display}")

                # Step 1: 检查 chrome.storage.local 中是否已有缓存
                existing = await check_cached_summary(sidebar_page, url)
                if existing:
                    print(f"  ✓ 已有缓存，跳过")
                    cache_key = SUMMARY_CACHE_PREFIX + url
                    if cache_key not in cache_json:
                        cache_json[cache_key] = existing
                        save_cache_json(SUMMARY_CACHE_JSON_PATH, cache_json)
                    cached_count += 1
                    continue

                # Step 2: 打开网页，触发 content.js -> PAGE_LOADED -> summarizePage()
                print(f"  打开网页: {url}")
                content_page = await context.new_page()
                try:
                    await content_page.goto(url, timeout=PAGE_LOAD_TIMEOUT, wait_until="domcontentloaded")
                    url=content_page.url  # 更新为实际加载后的 URL（处理重定向）
                    print(f"  页面加载完成，等待 content script 注入...")
                except Exception as e:
                    print(f"  ✗ 页面加载失败: {type(e).__name__}: {e}")
                    try:
                        await content_page.close()
                    except Exception:
                        pass
                    failed_count += 1
                    continue

                # 等待 content script 注入并发送 PAGE_LOADED
                await asyncio.sleep(WAIT_AFTER_PAGE_LOAD)

                # Step 3: 轮询等待摘要生成完成
                print(f"  等待摘要生成 (最长 {SUMMARY_TIMEOUT}s)...")
                summary_data = await wait_for_summary_cached(sidebar_page, url, SUMMARY_TIMEOUT)

                # Step 4: 关闭网页
                try:
                    await content_page.close()
                except Exception:
                    pass

                if summary_data:
                    print(f"  ✓ 摘要已生成 (长度: {len(summary_data.get('summary', ''))} chars)")

                    # 保存到 summary_cache.json
                    cache_key = SUMMARY_CACHE_PREFIX + url
                    cache_json[cache_key] = summary_data
                    save_cache_json(SUMMARY_CACHE_JSON_PATH, cache_json)
                    generated_count += 1
                else:
                    print(f"  ✗ 摘要生成超时")
                    failed_count += 1

            # # ==================== 最终导出全部缓存 ====================
            # print(f"\n{'=' * 60}")
            # print("导出全部 chrome.storage.local 摘要到 summary_cache.json ...")
            # all_summaries = await get_all_cached_summaries(sidebar_page)
            # for url, data in all_summaries.items():
            #     cache_key = SUMMARY_CACHE_PREFIX + url
            #     cache_json[cache_key] = data
            # save_cache_json(SUMMARY_CACHE_JSON_PATH, cache_json)

            # ==================== 完成 ====================
            print(f"\n{'=' * 60}")
            print(f"预缓存完成！")
            print(f"  已有缓存（跳过）: {cached_count}")
            print(f"  新生成摘要: {generated_count}")
            print(f"  失败: {failed_count}")
            print(f"  summary_cache.json 总条目: {len(cache_json)}")
            print(f"\n结果已保存至: {SUMMARY_CACHE_JSON_PATH}")
            print(f"chrome.storage.local 缓存保留在: {USER_DATA_DIR}")

        except KeyboardInterrupt:
            print("\n\n用户中断，保存当前缓存...")
            save_cache_json(SUMMARY_CACHE_JSON_PATH, cache_json)
            print(f"已保存 {len(cache_json)} 条缓存到 {SUMMARY_CACHE_JSON_PATH}")
        except Exception as e:
            print(f"\n错误: {e}")
            if cache_json:
                save_cache_json(SUMMARY_CACHE_JSON_PATH, cache_json)
                print(f"已保存 {len(cache_json)} 条缓存到 {SUMMARY_CACHE_JSON_PATH}")
            raise
        finally:
            await context.close()
            if server:
                server.shutdown()
                print("  本地 HTTP 服务器已关闭")


if __name__ == "__main__":
    asyncio.run(main())
