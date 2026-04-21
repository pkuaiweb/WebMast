"""
网页内容抓取脚本
=================
读取 Master-Thesis/data 下所有任务 JSON 文件，提取所有唯一 URL，
用 Playwright 打开每个网页，提取 document.body.innerText，
生成 HTML 文件保存到 WebMast/files/html/ 目录下。

生成的 HTML 文件保证 document.body.innerText 与原始网页一致，
同时在 <head> 中保留原始 URL 和标题信息。

使用方式:
    pip install playwright
    playwright install chromium
    python scripts/save_pages.py

输出:
    files/html/*.html       - 各网页的纯文本 HTML 文件
    files/html/url_map.json - 原始 URL → 本地文件名的映射
"""

import json
import asyncio
import hashlib
import html
import os
import sys
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright

# ==================== 配置 ====================

SCRIPT_DIR = Path(__file__).parent.resolve()
PROJECT_DIR = SCRIPT_DIR.parent  # WebMast/

DATA_DIR = str(PROJECT_DIR.parent / "Master-Thesis" / "data")
OUTPUT_DIR = str(PROJECT_DIR / "files" / "html")
URL_MAP_PATH = os.path.join(OUTPUT_DIR, "url_map.json")

PAGE_LOAD_TIMEOUT = 60000   # 页面加载超时 (ms)
WAIT_AFTER_LOAD = 3          # 页面加载后等待动态内容 (秒)

# 要读取的任务 JSON 文件（排除 summary_cache.json 等非任务文件）
TASK_JSON_FILES = ["gitlab.json", "map.json", "reddit.json", "shopping.json", "wiki.json"]

# 端口 → 站点名称映射（用于文件名前缀）
PORT_SITE_MAP = {
    "3000": "map",
    "7770": "shopping",
    "8023": "gitlab",
    "8888": "wiki",
    "9999": "reddit",
}


# ==================== 工具函数 ====================

def _sanitize(s: str, max_len: int = 80) -> str:
    """清理字符串为安全文件名片段"""
    safe_chars = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")
    result = "".join(c if c in safe_chars else "_" for c in s)
    while "__" in result:
        result = result.replace("__", "_")
    return result.strip("_")[:max_len]


def url_to_filename(url: str) -> str:
    """
    将 URL 转换为可读文件名，尽量保留原路径后缀信息。

    命名策略:
      {site}_{path_suffix}_{hash8}.html
    示例:
      gitlab_millennials-to-snake-people_issues_a1b2c3d4.html
      map_way_1017269763_a1b2c3d4.html
      reddit_why-bleaching-your-butthole-isn-t-called_a1b2c3d4.html
      shopping_sony-wh-ch710n-h-wireless-bluetooth_a1b2c3d4.html
      wiki_Allen_East_High_School_a1b2c3d4.html
    """
    url_hash = hashlib.md5(url.encode()).hexdigest()[:8]
    parsed = urlparse(url)

    # 识别站点类型
    port = parsed.netloc.split(":")[-1] if ":" in parsed.netloc else ""
    site = PORT_SITE_MAP.get(port, "site")

    # 提取有意义的路径后缀
    path = parsed.path.strip("/")

    # 去掉 .html 扩展名（shopping 页面自带 .html）
    if path.endswith(".html"):
        path = path[:-5]

    # 对不同站点做针对性处理，保留最有辨识度的部分
    if site == "wiki":
        # /wikipedia_en_all_maxi_2022-05/A/Montauk_Airport → Montauk_Airport
        parts = path.split("/")
        # 取最后一个有意义的段（跳过 wikipedia_en_all_maxi_2022-05 和 A）
        path_suffix = parts[-1] if parts else path
    elif site == "reddit":
        # /f/AskReddit/10224/why-bleaching-... → AskReddit_why-bleaching-...
        parts = path.split("/")
        # 格式: f/{forum}/{id}/{slug}
        if len(parts) >= 4:
            path_suffix = f"{parts[1]}_{parts[3]}"
        elif len(parts) >= 2:
            path_suffix = "_".join(parts[1:])
        else:
            path_suffix = path
    elif site == "map":
        # /way/1017269763 → way_1017269763; /directions → directions
        path_suffix = path.replace("/", "_")
    elif site == "gitlab":
        # /byteblaze/millennials-to-snake-people/-/issues → millennials-to-snake-people_issues
        parts = path.split("/")
        # 过滤掉 "-" 这种 GitLab 路由占位符
        parts = [p for p in parts if p != "-"]
        # 取最后 2-3 个有意义的段
        path_suffix = "_".join(parts[-3:]) if len(parts) > 3 else "_".join(parts)
    elif site == "shopping":
        # 长产品名，取前 60 字符
        path_suffix = path.replace("/", "_")
    else:
        path_suffix = path.replace("/", "_")

    path_suffix = _sanitize(path_suffix, max_len=120)

    # 如果路径为空（如根路径 /），使用 "index"
    if not path_suffix:
        path_suffix = "index"

    return f"{site}_{path_suffix}_{url_hash}.html"


def collect_unique_urls(data_dir: str) -> list[str]:
    """从所有任务 JSON 中收集唯一 URL"""
    urls = set()
    for filename in TASK_JSON_FILES:
        filepath = os.path.join(data_dir, filename)
        if not os.path.exists(filepath):
            print(f"  跳过不存在的文件: {filename}")
            continue
        with open(filepath, "r", encoding="utf-8") as f:
            tasks = json.load(f)
        for task in tasks:
            for url in task.get("open_url", []):
                urls.add(url)
        print(f"  {filename}: 提取 URL 后累计 {len(urls)} 个唯一 URL")
    return sorted(urls)


def make_html(title: str, url: str, inner_text: str) -> str:
    """
    生成 HTML 文件内容。
    确保 document.body.innerText 与原始网页一致。
    """
    escaped_title = html.escape(title)
    escaped_url = html.escape(url)
    escaped_text = html.escape(inner_text)
    return (
        "<!DOCTYPE html>\n"
        '<html lang="en">\n'
        "<head>\n"
        '<meta charset="UTF-8">\n'
        f"<title>{escaped_title}</title>\n"
        f'<meta name="original-url" content="{escaped_url}">\n'
        "</head>\n"
        f"<body><pre style=\"white-space:pre-wrap;font-family:sans-serif;\">{escaped_text}</pre></body>\n"
        "</html>"
    )


# ==================== 主流程 ====================

async def main():
    print(f"数据目录: {DATA_DIR}")
    print(f"输出目录: {OUTPUT_DIR}")

    # 收集唯一 URL
    urls = collect_unique_urls(DATA_DIR)
    print(f"\n共收集到 {len(urls)} 个唯一 URL")

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    # 加载已有映射（支持断点续传）
    url_map: dict[str, str | None] = {}
    if os.path.exists(URL_MAP_PATH):
        with open(URL_MAP_PATH, "r", encoding="utf-8") as f:
            url_map = json.load(f)
        print(f"已加载 {len(url_map)} 个已有映射")

    # 过滤掉已成功处理的 URL（值为 None 的是之前失败的，需要重试）
    urls_to_process = [u for u in urls if u not in url_map or url_map[u] is None]
    print(f"需要处理 {len(urls_to_process)} 个 URL")

    if not urls_to_process:
        print("所有 URL 已处理完毕！")
        return

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(viewport={"width": 1280, "height": 900})

        for idx, url in enumerate(urls_to_process):
            print(f"\n[{idx + 1}/{len(urls_to_process)}] {url[:100]}...")
            filename = url_to_filename(url)
            filepath = os.path.join(OUTPUT_DIR, filename)

            page = await context.new_page()
            try:
                await page.goto(url, timeout=PAGE_LOAD_TIMEOUT, wait_until="domcontentloaded")
                await asyncio.sleep(WAIT_AFTER_LOAD)

                # 提取 innerText 和 title
                inner_text = await page.evaluate("document.body.innerText || ''")
                title = await page.evaluate("document.title || ''")

                if not inner_text.strip():
                    print(f"  警告: 页面内容为空")

                # 生成并保存 HTML
                html_content = make_html(title, url, inner_text)
                with open(filepath, "w", encoding="utf-8") as f:
                    f.write(html_content)

                url_map[url] = filename
                print(f"  已保存: {filename} (innerText {len(inner_text)} chars)")

            except Exception as e:
                print(f"  失败: {type(e).__name__}: {e}")
                url_map[url] = None  # 标记为失败，下次运行会重试
            finally:
                await page.close()

            # 每处理一个 URL 就保存映射（防止中断丢失进度）
            with open(URL_MAP_PATH, "w", encoding="utf-8") as f:
                json.dump(url_map, f, indent=2, ensure_ascii=False)

        await browser.close()

    # 汇总
    success_count = sum(1 for v in url_map.values() if v is not None)
    fail_count = sum(1 for v in url_map.values() if v is None)
    print(f"\n{'=' * 60}")
    print(f"完成！成功: {success_count}, 失败: {fail_count}, 总计: {len(url_map)}")
    print(f"HTML 文件: {OUTPUT_DIR}")
    print(f"URL 映射: {URL_MAP_PATH}")

    if fail_count:
        print(f"\n失败的 URL:")
        for url, fname in url_map.items():
            if fname is None:
                print(f"  - {url}")


if __name__ == "__main__":
    asyncio.run(main())
