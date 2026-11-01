# -*- coding: utf-8 -*-
"""
软件著作权登记 PDF 鉴别材料生成器（生成 HTML 源，再用 Edge/Chrome 无头打印为 PDF）。

产出：
  server/软著材料/程序鉴别材料.html   （源程序前30页 + 后30页）
  server/软著材料/文档鉴别材料.html   （用户操作手册）

用法：
  1. python generate_copyright_materials.py
  2. 用 Edge 无头打印：
     msedge --headless --disable-gpu --no-pdf-header-footer \
            --print-to-pdf="程序鉴别材料.pdf" "file:///.../程序鉴别材料.html"
"""
import os
import html as _html
import subprocess

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"


def convert_to_pdf(html_path):
    """用 Edge 无头打印把 HTML 转成同名 PDF。"""
    pdf_path = html_path[:-5] + ".pdf"
    uri = "file:///" + os.path.abspath(html_path).replace("\\", "/")
    subprocess.run([EDGE, "--headless", "--disable-gpu", "--no-pdf-header-footer",
                    "--print-to-pdf=%s" % pdf_path, uri], check=True)
    with open(pdf_path, "rb") as f:
        data = f.read()
    pages = len(__import__("re").findall(rb"/Type\s*/Page(?![s])", data))
    return pdf_path, pages

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(SCRIPT_DIR)  # server/
OUT_DIR = os.path.join(ROOT, "软著材料")
os.makedirs(OUT_DIR, exist_ok=True)

SOFT_FULL = "AI剧本网（海龟汤/DND/COC/剧本扮演分享与体验平台）V3.0.0"
LINES_PER_PAGE = 50
FRONT_PAGES = 30   # 前 30 页
BACK_PAGES = 30    # 后 30 页

PAGE_CSS = """
@page { size: A4; margin: 0; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: "Microsoft YaHei", "SimSun", sans-serif; color: #111; }
.page {
  width: 210mm; height: 297mm;
  padding: 13mm 10mm 8mm 10mm;
  page-break-after: always;
  position: relative;
  overflow: hidden;
}
.phead {
  display: flex; justify-content: space-between; align-items: baseline;
  font-size: 9pt; color: #222;
  border-bottom: 0.5pt solid #999;
  padding-bottom: 1.5mm; margin-bottom: 2.5mm;
}
.phead .t { font-weight: bold; }
.code {
  font-family: Consolas, "Courier New", "Microsoft YaHei", monospace;
  font-size: 8pt; line-height: 1.42;
  white-space: pre-wrap; word-break: break-all;
}
.sep {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  height: 100%; text-align: center;
}
.sep .l1 { font-size: 16pt; font-weight: bold; margin-bottom: 4mm; }
.sep .l2 { font-size: 11pt; color: #555; }
"""


def _rel(p):
    return os.path.relpath(p, ROOT).replace("\\", "/")


def collect_source_files():
    """按约定顺序收集自研源程序文件。"""
    files = []
    backend = os.path.join(ROOT, "backend")
    for name in ("main.py", "__init__.py"):
        p = os.path.join(backend, name)
        if os.path.isfile(p):
            files.append(p)
    for d in ("core", "models", "schemas", "routers", "services", "seed"):
        dp = os.path.join(backend, d)
        if os.path.isdir(dp):
            for f in sorted(os.listdir(dp)):
                if f.endswith(".py"):
                    files.append(os.path.join(dp, f))

    frontend = os.path.join(ROOT, "frontend")
    ip = os.path.join(frontend, "index.html")
    if os.path.isfile(ip):
        files.append(ip)
    cssdir = os.path.join(frontend, "css")
    if os.path.isdir(cssdir):
        for f in sorted(os.listdir(cssdir)):
            if f.endswith(".css"):
                files.append(os.path.join(cssdir, f))
    shared = os.path.join(frontend, "js", "shared")
    if os.path.isdir(shared):
        for f in sorted(os.listdir(shared)):
            if f.endswith(".js"):
                files.append(os.path.join(shared, f))
    moddir = os.path.join(frontend, "js", "modules")
    if os.path.isdir(moddir):
        for dp, dirs, fn in os.walk(moddir):
            dirs.sort()
            for f in sorted(fn):
                if f.endswith(".js"):
                    files.append(os.path.join(dp, f))
    jsroot = os.path.join(frontend, "js")
    if os.path.isdir(jsroot):
        for f in sorted(os.listdir(jsroot)):
            fp = os.path.join(jsroot, f)
            if os.path.isfile(fp) and f.endswith(".js"):
                files.append(fp)
    return files


def collect_lines():
    """返回逐行源代码列表（含文件分隔注释）。"""
    lines = []
    for path in collect_source_files():
        lines.append("/* ==================== %s ==================== */" % _rel(path))
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()
        except Exception:
            lines.append("")
            continue
        fl = content.split("\n")
        while fl and fl[-1] == "":
            fl.pop()
        lines.extend(fl)
        lines.append("")
    return lines


def _page_html(header_title, page_no, body_inner):
    return (
        '<div class="page"><div class="phead">'
        '<span class="t">%s</span><span>第 %d 页</span>'
        "</div>%s</div>\n" % (_html.escape(header_title), page_no, body_inner)
    )


def gen_program_html():
    lines = collect_lines()
    total_pages = (len(lines) + LINES_PER_PAGE - 1) // LINES_PER_PAGE
    pages = []
    for i in range(total_pages):
        chunk = lines[i * LINES_PER_PAGE:(i + 1) * LINES_PER_PAGE]
        pages.append(chunk)

    front = pages[:FRONT_PAGES]
    back = pages[-BACK_PAGES:] if total_pages > FRONT_PAGES else []

    parts = []
    for idx, chunk in enumerate(front):
        body = '<div class="code">%s</div>' % _html.escape("\n".join(chunk))
        parts.append(_page_html(SOFT_FULL, idx + 1, body))

    if back:
        skipped = total_pages - FRONT_PAGES - len(back)
        sep = ('<div class="page"><div class="sep">'
               '<div class="l1">（中间 %d 页略）</div>'
               '<div class="l2">以下为源程序后 %d 页（第 %d-%d 页）</div>'
               "</div></div>\n" % (skipped, len(back), total_pages - len(back) + 1, total_pages))
        parts.append(sep)
        start = total_pages - len(back)
        for j, chunk in enumerate(back):
            body = '<div class="code">%s</div>' % _html.escape("\n".join(chunk))
            parts.append(_page_html(SOFT_FULL, start + j + 1, body))

    html = ('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
            '<title>程序鉴别材料</title><style>%s</style></head><body>%s</body></html>'
            % (PAGE_CSS, "".join(parts)))
    out = os.path.join(OUT_DIR, "程序鉴别材料.html")
    with open(out, "w", encoding="utf-8") as f:
        f.write(html)
    return out, total_pages, len(lines)


# ==================== 用户操作手册 ====================
def _doc_pages():
    """返回手册页内容列表（每页一段 HTML）。"""
    p = []
    def add(html_str):
        p.append('<div class="doc">%s</div>' % html_str)

    add('<h1>AI剧本网<br>用户操作手册</h1>'
        '<p class="sub">（海龟汤 / DND / COC / 剧本扮演 分享与体验平台）</p>'
        '<p class="meta">软件版本：V3.0.0</p>')
    add('<h2>目录</h2>'
        '<p>第一章 软件概述<br>第二章 运行环境<br>第三章 软件安装与部署<br>'
        '第四章 用户注册与登录<br>第五章 剧本浏览与检索<br>第六章 剧本详情查看<br>'
        '第七章 剧本上传与编辑<br>第八章 剧本审核流程<br>第九章 AI 沉浸式剧本体验<br>'
        '第十章 互动与社区<br>第十一章 管理后台<br>第十二章 安全与合规<br>附录 常见问题</p>')
    add('<h2>第一章 软件概述</h2>'
        '<h3>1.1 软件简介</h3>'
        '<p>《AI剧本网》是一款面向剧本推理爱好者的在线剧本分享与沉浸式体验平台，'
        '收录海龟汤、DND（龙与地下城）、COC（克苏鲁的呼唤）及剧本扮演四大类剧本。'
        '用户可在平台上浏览、下载、创作剧本，并通过大语言模型驱动的 NPC 主持人进行多轮对话式推理体验。</p>'
        '<h3>1.2 主要特点</h3>'
        '<p>（1）海量剧本分类检索与下载；<br>（2）AI 大模型驱动的沉浸式剧本体验；<br>'
        '（3）AI 初审与人工复审双重内容审核保障；<br>（4）完善的社区互动与合规管理体系。</p>'
        '<h3>1.3 适用对象</h3>'
        '<p>本软件适用于剧本杀、海龟汤、跑团（TRPG）等剧本推理爱好者、剧本创作者及内容运营者。</p>')
    add('<h2>第二章 运行环境</h2>'
        '<h3>2.1 服务端环境</h3>'
        '<p>操作系统：Linux；<br>'
        '运行支撑软件：Python 3.11、FastAPI、Uvicorn、Nginx、SQLite。</p>'
        '<h3>2.2 客户端环境</h3>'
        '<p>支持 Windows、macOS、Android、iOS 等主流操作系统，'
        '使用 Chrome、Edge、Safari 等现代浏览器即可访问，无需安装任何客户端程序。</p>'
        '<h3>2.3 网络环境</h3>'
        '<p>客户端需连接互联网，通过 HTTPS 协议访问平台。</p>')
    add('<h2>第三章 软件安装与部署</h2>'
        '<h3>3.1 依赖安装</h3>'
        '<p>（1）在服务器安装 Python 3.11 及以上版本；<br>'
        '（2）进入项目目录，执行命令 pip install -r requirements.txt 安装第三方依赖；<br>'
        '（3）安装并配置 Nginx 作为反向代理服务器。</p>'
        '<h3>3.2 数据库初始化</h3>'
        '<p>首次启动时系统自动创建数据表并写入种子数据，无需手动建库。</p>'
        '<h3>3.3 服务启动</h3>'
        '<p>通过 Uvicorn 启动 API 服务，并由 Nginx 反向代理对外提供 HTTPS 访问。</p>')
    add('<h2>第四章 用户注册与登录</h2>'
        '<h3>4.1 注册</h3>'
        '<p>（1）访问平台首页，点击右上角「注册」按钮进入注册面板；<br>'
        '（2）填写邮箱地址并设置登录密码；<br>'
        '（3）完成实名核验（须年满 18 周岁）；<br>'
        '（4）注册成功后自动跳转至登录状态。</p>'
        '<h3>4.2 登录</h3>'
        '<p>在登录面板输入注册邮箱与密码，点击「登录」即可进入个人中心。</p>'
        '<h3>4.3 找回密码</h3>'
        '<p>点击「忘记密码」，通过注册邮箱接收验证码后重置密码。</p>')
    add('<h2>第五章 剧本浏览与检索</h2>'
        '<h3>5.1 剧本列表</h3>'
        '<p>首页按海龟汤、DND、COC、剧本扮演四大分类展示剧本列表，'
        '用户可点击顶部分类标签切换查看不同类别的剧本。</p>'
        '<h3>5.2 检索与筛选</h3>'
        '<p>支持按关键词搜索剧本标题与简介，支持按热度、发布时间等条件排序。</p>')
    add('<h2>第六章 剧本详情查看</h2>'
        '<h3>6.1 详情内容</h3>'
        '<p>点击剧本卡片进入详情页，可查看剧本介绍、汤面（谜面）、汤底（谜底）及胜利/失败条件等信息。</p>'
        '<h3>6.2 条件展示</h3>'
        '<p>已通关用户可查看剧本的胜利结局与失败结局及其条件列表；未通关用户该部分内容隐藏，避免剧透。</p>')
    add('<h2>第七章 剧本上传与编辑</h2>'
        '<h3>7.1 上传剧本</h3>'
        '<p>（1）登录后点击「上传剧本」按钮进入上传页；<br>'
        '（2）选择剧本类型（海龟汤 / DND / COC / 剧本扮演）；<br>'
        '（3）填写剧本标题、简介、汤面（谜面）、汤底（谜底）等结构化信息；<br>'
        '（4）配置结局条件后提交审核。</p>'
        '<h3>7.2 结局条件配置</h3>'
        '<p>作者可为一个剧本配置任意个胜利/失败结局，每个结局包含若干条件'
        '（条件名称、触发规则、次数阈值、是否隐藏）。系统将依据这些条件在体验过程中自动判定结局。</p>')
    add('<h2>第七章 剧本上传与编辑（续）</h2>'
        '<h3>7.3 编辑剧本</h3>'
        '<p>在「我的剧本」列表中找到目标剧本，点击「编辑」可修改剧本内容与结局条件，'
        '修改后需重新提交审核。</p>'
        '<h3>7.4 删除与下架</h3>'
        '<p>作者可对自有剧本进行删除或申请下架操作。</p>')
    add('<h2>第八章 剧本审核流程</h2>'
        '<h3>8.1 双重审核机制</h3>'
        '<p>剧本提交后先由 AI 自动初审，自动识别违规、色情、暴力等不良内容并打标；'
        '再由站长人工复审，复审通过后方可公开发布。</p>'
        '<h3>8.2 审核状态</h3>'
        '<p>作者可在「我的剧本」中查看剧本审核状态（待审核 / 审核中 / 已通过 / 未通过）。</p>')
    add('<h2>第八章 剧本审核流程（续）</h2>'
        '<h3>8.3 举报处理</h3>'
        '<p>用户可在剧本详情页点击「举报」按钮，填写举报理由后提交；'
        '被举报作品将立即转入待审核队列，由站长复核处理。</p>')
    add('<h2>第九章 AI 沉浸式剧本体验</h2>'
        '<h3>9.1 开始体验</h3>'
        '<p>在剧本详情页点击「开始体验」，系统弹出确认框，确认后进入剧本体验界面。</p>'
        '<h3>9.2 对话推理</h3>'
        '<p>系统根据剧本内容与所选模式动态构建角色扮演提示词，驱动 NPC 主持人引导玩家推理、'
        '逐步揭示剧情线索。玩家通过底部输入框与 NPC 进行多轮对话。</p>')
    add('<h2>第九章 AI 沉浸式剧本体验（续）</h2>'
        '<h3>9.3 结局结算</h3>'
        '<p>NPC 依据玩家行为实时判定胜利/失败结局，自动触发结算弹窗；'
        '达成胜利结局后解锁汤底，失败结局不解锁汤底。</p>'
        '<h3>9.4 工具面板</h3>'
        '<p>体验过程中点击输入框左侧的记事本按钮，可打开底部工具面板，'
        '查看汤面与已揭示条件（横屏并排、竖屏纵排）。</p>')
    add('<h2>第十章 互动与社区</h2>'
        '<h3>10.1 点赞 / 点踩 / 收藏 / 下载</h3>'
        '<p>用户可对剧本进行点赞、点踩、收藏与下载操作。</p>'
        '<h3>10.2 评论</h3>'
        '<p>在剧本详情页下方可发表评论，与其他用户交流讨论。</p>')
    add('<h2>第十一章 管理后台</h2>'
        '<h3>11.1 功能概述</h3>'
        '<p>站长通过后台管理剧本、审核队列、用户、公告及 NPC 提示词配置。</p>'
        '<h3>11.2 提示词配置</h3>'
        '<p>支持 NPC 提示词的分类标签化编辑与多模型参数配置，'
        '可针对海龟汤、DND、COC、剧本扮演等不同模式分别设置主持提示词。</p>')
    add('<h2>第十二章 安全与合规</h2>'
        '<h3>12.1 访问日志</h3>'
        '<p>平台自动记录用户访问日志（账号、登录退出时间、操作类型、IP、端口等）并留存 60 日。</p>'
        '<h3>12.2 实名认证</h3>'
        '<p>集成国家网络身份认证公共服务，注册需满 18 周岁，平台不留存用户身份证件信息。</p>'
        '<h3>12.3 备案信息</h3>'
        '<p>首页底部显著位置悬挂 ICP 备案号并链接至工信部官网。</p>')
    add('<h2>附录 常见问题（FAQ）</h2>'
        '<h3>Q1：忘记密码怎么办？</h3>'
        '<p>在登录面板点击「忘记密码」，通过注册邮箱接收验证码后重置密码。</p>'
        '<h3>Q2：上传的剧本为什么没有立即显示？</h3>'
        '<p>剧本提交后需经过 AI 初审与站长复审，审核通过后才会公开发布。</p>'
        '<h3>Q3：如何举报违规作品？</h3>'
        '<p>在剧本详情页点击「举报」按钮，填写举报理由后提交，作品将立即转入待审核队列。</p>')
    return p


def gen_doc_html():
    pages = _doc_pages()
    parts = [_page_html(SOFT_FULL, i + 1, inner) for i, inner in enumerate(pages)]
    doc_css = PAGE_CSS + """
.doc h1 { font-size: 22pt; text-align: center; margin-top: 60mm; }
.doc .sub { text-align: center; font-size: 13pt; color: #444; margin-top: 6mm; }
.doc .meta { text-align: center; font-size: 12pt; color: #666; margin-top: 10mm; }
.doc h2 { font-size: 14pt; margin: 6mm 0 3mm; border-left: 3mm solid #333; padding-left: 2mm; }
.doc h3 { font-size: 11pt; margin: 3mm 0 1.5mm; }
.doc p { font-size: 10.5pt; line-height: 1.9; text-align: justify; margin: 1.5mm 0; }
"""
    html = ('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
            '<title>文档鉴别材料</title><style>%s</style></head><body>%s</body></html>'
            % (doc_css, "".join(parts)))
    out = os.path.join(OUT_DIR, "文档鉴别材料.html")
    with open(out, "w", encoding="utf-8") as f:
        f.write(html)
    return out, len(pages)


if __name__ == "__main__":
    prog, total_pages, total_lines = gen_program_html()
    doc, doc_pages = gen_doc_html()
    pure = [l for l in collect_lines() if l.strip() and not l.startswith("/* ====")]
    print("程序鉴别材料: %s" % prog)
    print("  纯代码 %d 行（含分隔注释共 %d 行），总页数 %d（前 %d 页 + 后 %d 页）"
          % (len(pure), total_lines, total_pages, FRONT_PAGES, BACK_PAGES))
    print("文档鉴别材料: %s（共 %d 页）" % (doc, doc_pages))
    if os.path.isfile(EDGE):
        print("转 PDF 中...")
        ppdf, ppages = convert_to_pdf(prog)
        dpdf, dpages = convert_to_pdf(doc)
        print("程序 PDF: %s（%d 页）" % (ppdf, ppages))
        print("文档 PDF: %s（%d 页）" % (dpdf, dpages))
    else:
        print("未找到 Edge，请手动用浏览器打印 HTML 为 PDF。")
