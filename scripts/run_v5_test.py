"""
WebMast Extension Automated Testing Script
============================================
自动化测试 WebMast 浏览器扩展：
1. 启动 Edge 浏览器（加载 WebMast 扩展）
2. 对 v5.json 中每个任务，依次打开 open_url 中的网站
3. 等待网站加载完毕，打开 WebMast 扩展侧边栏
4. 在 WebMast 输入框输入 intent，等待回复，记录 answer 和 TTFT
5. 每个任务重复 3 次
6. 将所有运行结果记录到 JSON 文件中

使用方式:
    pip install playwright
    playwright install chromium
    python scripts/run_v5_test.py

注意：
    - 首次运行时 WebMast 需要下载模型，可能需要几分钟
    - 如果目标网站需要登录，首次运行会暂停让你手动登录
    - 使用持久化浏览器 profile，登录状态会被保留
"""

import json
import asyncio
import time
import re
import os
import sys
import shutil
from pathlib import Path
from playwright.async_api import async_playwright

# ==================== 配置 ====================

SCRIPT_DIR = Path(__file__).parent.resolve()
PROJECT_DIR = SCRIPT_DIR.parent  # WebMast/

EXTENSION_PATH = str(PROJECT_DIR / "dist")
V5_JSON_PATH = str(PROJECT_DIR.parent / "正文" / "data" / "v5.json")
OUTPUT_DIR = str(PROJECT_DIR.parent / "正文" / "data")
USER_DATA_DIR = str(PROJECT_DIR / "test-profile")

REPEAT_COUNT = 3                  # 每个任务重复次数
PAGE_LOAD_TIMEOUT = 60000         # 页面加载超时 (ms)
ENGINE_READY_TIMEOUT = 1200000     # 引擎加载超时 (ms), 首次下载模型较慢
ANSWER_TIMEOUT = 90              # 等待回答超时 (秒)
ANSWER_STABLE_SECONDS = 5         # 回答内容稳定多少秒视为完成
WAIT_AFTER_PAGE_LOAD = 8          # 页面加载后等待 content script 注入的秒数
NEED_LOGIN = False                 # 是否需要登录（首次运行时暂停让用户手动登录）
BACKGROUND_TS_PATH = str(PROJECT_DIR / "src" / "background.ts")


def parse_background_constants() -> dict:
    """从 background.ts 中解析 DEFAULT_MODEL_ID 和 WORKFLOW_TYPE"""
    result = {"model_id": "unknown", "workflow_type": "unknown"}
    try:
        with open(BACKGROUND_TS_PATH, "r", encoding="utf-8") as f:
            content = f.read()
        m = re.search(r'const\s+DEFAULT_MODEL_ID\s*=\s*"([^"]+)"', content)
        if m:
            result["model_id"] = m.group(1)
        m = re.search(r'const\s+WORKFLOW_TYPE\s*:\s*number\s*=\s*(\d+)', content)
        if m:
            result["workflow_type"] = int(m.group(1))
    except Exception as e:
        print(f"  警告: 无法解析 background.ts 常量: {e}")
    return result


async def get_extension_id(context) -> str:
    """从 service worker 或 background page 获取扩展 ID"""
    # 轮询等待 service worker 注册（持久化 profile 下 SW 可能延迟激活）
    print("  等待扩展 service worker 注册...")
    for attempt in range(30):
        if context.service_workers:
            sw = context.service_workers[0]
            ext_id = sw.url.split("/")[2]
            print(f"  扩展 ID (service worker): {ext_id}")
            return ext_id
        # MV2 fallback: 检查 background pages
        if context.background_pages:
            bg = context.background_pages[0]
            ext_id = bg.url.split("/")[2]
            print(f"  扩展 ID (background page): {ext_id}")
            return ext_id
        await asyncio.sleep(2)

    # 最终fallback: 等待 serviceworker 事件
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

    # fill() 不触发 keyup 事件，而 sidebar.ts 依赖 keyup 来启用 submit 按钮
    # 手动 dispatch 一个 keyup 事件来启用按钮
    await input_el.dispatch_event("keyup")

    # 等待 submit button 启用（state 参数不支持 "enabled"，用 wait_for_function）
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

    # Step 1: 等待 answer 区域出现内容（第一个 chunk 到达）
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
        # 尝试获取当前内容
        answer = await sidebar_page.evaluate(
            "document.getElementById('answer')?.innerText || ''"
        )
        return (answer.strip() or "timeout", "N/A")

    # Step 2: 获取 TTFT（此时 timer 已冻结）
    ttft_text = await sidebar_page.text_content("#elapsed-timer") or ""
    ttft_match = re.search(r"([\d.]+)\s*s", ttft_text)
    ttft = ttft_match.group(1) if ttft_match else "N/A"

    # Step 3: 等待回答内容稳定（不再变化超过 ANSWER_STABLE_SECONDS 秒即视为完成）
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
                break  # 内容已稳定
        else:
            stable_start = None
            last_answer = current

        await asyncio.sleep(0.5)

    # 获取最终答案
    final_answer = await sidebar_page.evaluate(
        "document.getElementById('answer')?.innerText || ''"
    )
    # 再次获取 TTFT（防止前面获取太早）
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
    这些标签页在 sidebar 之前创建，确保 tab index 正确。
    """
    pages = []
    for url in urls:
        page = await context.new_page()
        try:
            await page.goto(url, timeout=PAGE_LOAD_TIMEOUT, wait_until="domcontentloaded")
            print(f"    已打开: {url[:80]}...")
        except Exception as e:
            print(f"    页面加载警告 ({url[:60]}...): {type(e).__name__}")
        pages.append(page)

    # 等待 content script 注入和页面处理
    await asyncio.sleep(WAIT_AFTER_PAGE_LOAD)
    return pages


async def handle_login_if_needed(context):
    """首次运行时暂停让用户手动登录"""
    if not NEED_LOGIN:
        return

    login_marker = os.path.join(USER_DATA_DIR, ".login_done")
    if os.path.exists(login_marker):
        print("  已检测到登录标记，跳过登录步骤")
        return

    # 打开登录页面
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

    # 等待用户按 Enter
    await asyncio.get_event_loop().run_in_executor(None, input)

    # 标记已登录
    os.makedirs(USER_DATA_DIR, exist_ok=True)
    with open(login_marker, "w") as f:
        f.write("logged in")
    print("  登录标记已保存")

    await page.close()


async def main():
    # 加载任务数据
    with open(V5_JSON_PATH, "r", encoding="utf-8") as f:
        tasks = json.load(f)
    print(f"已加载 {len(tasks)} 个任务")

    # 解析 background.ts 中的常量
    bg_constants = parse_background_constants()
    model_short = bg_constants["model_id"]  # e.g. "Qwen3"
    wf_type = bg_constants["workflow_type"]
    OUTPUT_PATH = os.path.join(OUTPUT_DIR, f"v5_results_{model_short}_wf{wf_type}_headless_arm.json")
    print(f"Model ID: {bg_constants['model_id']}, Workflow Type: {wf_type}")
    print(f"输出文件: {OUTPUT_PATH}")

    # 获取 sidebar 文件名
    sidebar_filename = get_sidebar_filename(EXTENSION_PATH)
    print(f"Sidebar 文件: {sidebar_filename}")

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

        # 清除旧的扩展缓存，防止 rebuild 后旧 SW 残留导致新 SW 无法注册
        # 注意：保留 Service Worker/CacheStorage/（WebLLM 模型权重缓存在这里）
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
            headless=False,          # 保持 False，通过 --headless=new 启用新 headless 模式（支持扩展）
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

                print(f"\n{'=' * 60}")
                print(f"[{task_idx+1}/{len(tasks)}] Task ID: {task_id}")
                print(f"  Intent: {intent}")
                print(f"  URLs: {len(open_urls)} 个")

                task_result = {
                    "task_id": task_id,
                    "runs": [],
                }

                # ---- 打开所有内容标签页 ----

                # 先关闭旧的内容标签页
                await close_content_tabs(context, sidebar_page)

                # 打开新内容标签页
                content_pages = await open_content_tabs(context, open_urls)

                # ---- 重复提交 3 次 ----
                for run_idx in range(REPEAT_COUNT):
                    print(f"\n  --- Run {run_idx+1}/{REPEAT_COUNT} ---")

                    # 每次 run 都关闭并重新打开 sidebar，确保状态干净
                    try:
                        await asyncio.sleep(2)  # 等待可能的后台处理完成
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
            # 保存已有结果
            if results:
                with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
                    json.dump(results, f, indent=2, ensure_ascii=False)
                print(f"已保存 {len(results)} 个任务的结果到 {OUTPUT_PATH}")
            raise
        finally:
            await context.close()


if __name__ == "__main__":
    asyncio.run(main())
