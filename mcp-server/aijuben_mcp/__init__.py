"""AI剧本网（jvben.cn）MCP 插件。

这个包只做一件事：把站点的 HTTP 接口翻译成 MCP 工具，让任意支持 MCP 的 AI 客户端
（Claude Desktop / Claude Code / Cursor / DSH / 自建 agent）能直接读剧本、读玩家档案、
并按照主持契约接管一场海龟汤。

刻意不做的事：
- 不 import 站点后端（backend/），不读 SQLite，不假设与站点同机部署；
- 不内置任何 LLM provider / API Key —— 模型是客户端自己的事，这里只管接口；
- 不实现"提交玩家发言"这一环（后端目前没有 turn 端点，见 README「已知出入」）。
"""

__version__ = "0.1.0"
__all__ = ["__version__"]
