"""后端 LLM 客户端（用于 AI 初审等需要服务端调度的场景）。

使用标准库 urllib，避免额外依赖（服务器环境未安装 requests）。

配置来源（优先级从高到低）：
  1. 环境变量：LLM_API_KEY / LLM_BASE_URL / LLM_MODEL
  2. 站点设置 SiteSettings(key="llm_config")，值为 {api_key, base_url, model}

若无可用密钥，所有方法返回 None，调用方应优雅降级（跳过 AI，直接进入人工审核）。
"""
import os
import json
import logging
import urllib.request
import urllib.error

logger = logging.getLogger("ai_client")

DEFAULT_BASE_URL = "https://api.openai.com/v1"
DEFAULT_MODEL = "gpt-4o-mini"
_TIMEOUT = 60


def _load_config() -> dict:
    api_key = os.environ.get("LLM_API_KEY", "")
    base_url = os.environ.get("LLM_BASE_URL", "") or DEFAULT_BASE_URL
    model = os.environ.get("LLM_MODEL", "") or DEFAULT_MODEL

    # 尝试从站点设置读取（延迟导入避免循环依赖）
    try:
        from ..core.database import SessionLocal
        from ..models.system import SiteSettings
        db = SessionLocal()
        try:
            row = db.query(SiteSettings).filter(SiteSettings.key == "llm_config").first()
            if row and isinstance(row.value, dict):
                api_key = api_key or row.value.get("api_key", "")
                base_url = row.value.get("base_url") or base_url
                model = row.value.get("model") or model
        finally:
            db.close()
    except Exception as e:  # 配置缺失不应阻断请求
        logger.warning("读取 LLM 站点配置失败：%s", e)

    return {"api_key": api_key, "base_url": base_url, "model": model}


def is_configured() -> bool:
    """当前是否已配置 LLM（供调用方判断是否启用 AI 初审）。"""
    return bool(_load_config()["api_key"])


def chat(messages: list[dict], temperature: float = 0.3) -> str | None:
    """调用 OpenAI 兼容接口，返回模型文本；失败返回 None。"""
    cfg = _load_config()
    if not cfg["api_key"]:
        return None
    url = cfg["base_url"].rstrip("/") + "/chat/completions"
    payload = {
        "model": cfg["model"],
        "messages": messages,
        "temperature": temperature,
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=data,
        headers={
            "Authorization": f"Bearer {cfg['api_key']}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
            body = resp.read().decode("utf-8")
        return json.loads(body)["choices"][0]["message"]["content"]
    except urllib.error.URLError as e:
        logger.error("AI 调用失败（网络）：%s", e)
        return None
    except Exception as e:
        logger.error("AI 调用失败：%s", e)
        return None


def chat_json(messages: list[dict], temperature: float = 0.3) -> dict | None:
    """调用并解析 JSON 返回。兼容模型在 JSON 外加 ```json 代码块的情况。"""
    text = chat(messages, temperature)
    if text is None:
        return None
    raw = text.strip()
    if raw.startswith("```"):
        raw = raw.split("```", 2)[1]
        if raw.startswith("json"):
            raw = raw[4:]
        raw = raw.strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        logger.error("AI 返回非 JSON：%s", text[:200])
        return None
