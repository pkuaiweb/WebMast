"""
WebMast Summary Pre-Cache Script
==================================
预缓存脚本：为 v5.json 中所有 URL 生成摘要缓存，以加速后续 run_v5_test.py 测试。

流程：
1. 启动 Edge 浏览器（加载 WebMast 扩展）
2. 等待 LLM 引擎就绪
3. 收集 v5.json 中所有唯一 URL
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
    python scripts/precache_summaries.py

注意：
    - 首次运行时 WebMast 需要下载模型，可能需要几分钟
    - 使用持久化浏览器 profile (test-profile/)，缓存会保留
    - 生成的 chrome.storage.local 缓存在 test-profile/ 中持久化，
      后续 run_v5_test.py 启动时可直接利用
"""

import asyncio
import json
import os
import re
import shutil
import time
from pathlib import Path
from playwright.async_api import async_playwright

# ==================== 配置 ====================

SCRIPT_DIR = Path(__file__).parent.resolve()
PROJECT_DIR = SCRIPT_DIR.parent  # WebMast/

EXTENSION_PATH = str(PROJECT_DIR / "dist")
V5_JSON_PATH = str(PROJECT_DIR.parent / "正文" / "data" / "v5.json")
SUMMARY_CACHE_JSON_PATH = str(PROJECT_DIR.parent / "正文" / "data" / "summary_cache.json")
USER_DATA_DIR = str(PROJECT_DIR / "test-profile")
BACKGROUND_TS_PATH = str(PROJECT_DIR / "src" / "background.ts")

PAGE_LOAD_TIMEOUT = 60000          # 页面加载超时 (ms)
ENGINE_READY_TIMEOUT = 1200000     # 引擎加载超时 (ms), 首次下载模型较慢
SUMMARY_TIMEOUT = 180              # 等待单个摘要生成超时 (秒)
WAIT_AFTER_PAGE_LOAD = 10          # 页面加载后等待 content script 注入 + PAGE_LOADED 发送的秒数
SUMMARY_CACHE_PREFIX = "page_summary_"
NEED_LOGIN = False


# ==================== 工具函数 ====================

def collect_unique_urls(tasks: list) -> list:
    """从 v5.json 任务列表中收集所有唯一 URL（保持顺序）"""
    seen = set()
    urls = []
    for task in tasks:
        for url in task.get("open_url", []):
            if url not in seen:
                seen.add(url)
                urls.append(url)
    return urls


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

async def main():
    # 加载任务数据
    with open(V5_JSON_PATH, "r", encoding="utf-8") as f:
        tasks = json.load(f)
    print(f"已加载 {len(tasks)} 个任务")

    # 收集唯一 URL
    all_urls = collect_unique_urls(tasks)
    print(f"共 {len(all_urls)} 个唯一 URL 需要处理")

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

        # 清除旧的扩展缓存（与 run_v5_test.py 保持一致），保留 CacheStorage（模型权重）
        sw_dir = os.path.join(USER_DATA_DIR, "Default", "Service Worker")
        for sw_sub in ["Database", "ScriptCache"]:
            path = os.path.join(sw_dir, sw_sub)
            if os.path.isdir(path):
                print(f"  清除缓存: Service Worker/{sw_sub}/")
                shutil.rmtree(path, ignore_errors=True)

        for subdir in [
            os.path.join(USER_DATA_DIR, "Default", "Extension State"),
            os.path.join(USER_DATA_DIR, "Default", "Extension Rules"),
            os.path.join(USER_DATA_DIR, "Default", "Extension Scripts"),
            os.path.join(USER_DATA_DIR, "Default", "Code Cache"),
        ]:
            if os.path.isdir(subdir):
                print(f"  清除缓存: {os.path.basename(subdir)}/")
                shutil.rmtree(subdir, ignore_errors=True)

        context = await p.chromium.launch_persistent_context(
            user_data_dir=USER_DATA_DIR,
            channel="msedge",
            headless=False,
            args=[
                "--headless=new",
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

            for idx, url in enumerate(all_urls):
                short_url = url[:80] + ("..." if len(url) > 80 else "")
                print(f"\n[{idx + 1}/{len(all_urls)}] {short_url}")

                # Step 1: 检查 chrome.storage.local 中是否已有缓存
                existing = await check_cached_summary(sidebar_page, url)
                if existing:
                    print(f"  ✓ 已有缓存，跳过")
                    # 同步到 summary_cache.json（如果 json 文件中没有）
                    cache_key = SUMMARY_CACHE_PREFIX + url
                    if cache_key not in cache_json:
                        cache_json[cache_key] = existing
                        save_cache_json(SUMMARY_CACHE_JSON_PATH, cache_json)
                    cached_count += 1
                    continue

                # Step 2: 打开网页，触发 content.js -> PAGE_LOADED -> summarizePage()
                print(f"  打开网页...")
                content_page = await context.new_page()
                try:
                    await content_page.goto(url, timeout=PAGE_LOAD_TIMEOUT, wait_until="domcontentloaded")
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

            # ==================== 最终导出全部缓存 ====================
            print(f"\n{'=' * 60}")
            print("导出全部 chrome.storage.local 摘要到 summary_cache.json ...")
            all_summaries = await get_all_cached_summaries(sidebar_page)
            for url, data in all_summaries.items():
                cache_key = SUMMARY_CACHE_PREFIX + url
                cache_json[cache_key] = data
            save_cache_json(SUMMARY_CACHE_JSON_PATH, cache_json)

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


if __name__ == "__main__":
    asyncio.run(main())
