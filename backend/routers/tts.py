"""TTS 语音路由"""
import io
import time
import asyncio
from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse

router = APIRouter(prefix="/api/tts", tags=["TTS"])

# 在线 TTS 音色列表（动态下发：GET /api/tts/voices 返回，前端设置页按 provider 分组渲染）。
# 后续接入豆包、火山引擎等第三方在线 TTS 时，在此追加 provider 不同的音色即可，前端无需改动。
VALID_VOICES = [
    {"id": "zh-CN-XiaoxiaoNeural", "name": "晓晓（女）", "gender": "female", "provider": "edge"},
    {"id": "zh-CN-XiaoyiNeural", "name": "晓伊（女）", "gender": "female", "provider": "edge"},
    {"id": "zh-CN-YunjianNeural", "name": "云健（男）", "gender": "male", "provider": "edge"},
    {"id": "zh-CN-YunxiNeural", "name": "云希（男）", "gender": "male", "provider": "edge"},
    {"id": "zh-CN-YunyangNeural", "name": "云扬（男）", "gender": "male", "provider": "edge"},
    {"id": "zh-CN-YunxiaNeural", "name": "云夏（男）", "gender": "male", "provider": "edge"},
    {"id": "zh-CN-liaoning-XiaobeiNeural", "name": "晓蓓·辽宁（女）", "gender": "female", "provider": "edge"},
    {"id": "zh-CN-shaanxi-XiaoniNeural", "name": "晓妮·陕西（女）", "gender": "female", "provider": "edge"},
]


# ---------------------------------------------------------------------------
# 能力探针：GET /api/tts/health
#
# 为什么需要它：前端默认引擎是 server（设置项 ttsEngine）。但服务端能不能真的合成，
# 取决于「venv 装没装 edge_tts」+「这台机器能不能连上微软的语音服务」——
# 后者在 2026-10 已经出过一次事：edge_tts 7.2.8 在服务器上握手被微软回 403
# （WSServerHandshakeError），网络通、时钟也对，就是被拒。
# 没有探针的话，每个用户这一天第一次朗读都要先白撞 2 次 500 才会退回浏览器。
# 这里做一次「真的合成一个字符」的实测并缓存结果，前端据此直接选引擎。
# ---------------------------------------------------------------------------
_PROBE_TTL_SECONDS = 600          # 结果缓存 10 分钟：微软恢复后最多等 10 分钟即可用上
_PROBE_TIMEOUT_SECONDS = 6.0      # 单次探测上限：探针自己不能变成卡顿源
_probe_cache = {"at": 0.0, "available": False, "reason": "尚未探测"}


async def _probe_once() -> tuple[bool, str]:
    """真的调一次微软接口，合成一个字符；返回 (可用, 原因)。"""
    try:
        import edge_tts
    except ImportError:
        return False, "服务端未安装 edge_tts"
    try:
        communicate = edge_tts.Communicate("嗯", VALID_VOICES[0]["id"])
        got = 0

        async def drain():
            nonlocal got
            async for chunk in communicate.stream():
                if chunk.get("type") == "audio":
                    got += len(chunk.get("data") or b"")

        await asyncio.wait_for(drain(), timeout=_PROBE_TIMEOUT_SECONDS)
        if got <= 0:
            return False, "微软语音接口没有返回音频数据"
        return True, ""
    except asyncio.TimeoutError:
        return False, "微软语音接口超时（%d 秒）" % int(_PROBE_TIMEOUT_SECONDS)
    except Exception as exc:                      # noqa: BLE001 —— 探针不能把异常抛给调用方
        return False, "%s: %s" % (type(exc).__name__, str(exc)[:120])


@router.get("/health")
async def tts_health(force: bool = Query(False)):
    """服务端语音是否可用。前端据此决定用服务端音色还是浏览器内置语音。

    - force=true 跳过缓存（后台排查用）
    - 只用 GET，不写库、不占用免费额度
    """
    now = time.time()
    if not force and (now - _probe_cache["at"]) < _PROBE_TTL_SECONDS:
        return dict(_probe_cache, cached=True)
    available, reason = await _probe_once()
    _probe_cache.update({"at": now, "available": available, "reason": reason})
    return dict(_probe_cache, cached=False)


@router.post("")
async def text_to_speech(req: dict):
    """Edge TTS 文本转语音（需要 edge_tts 可选依赖）"""
    text = req.get("text", "")
    voice = req.get("voice", "zh-CN-XiaoyiNeural")
    try:
        import edge_tts
        communicate = edge_tts.Communicate(text, voice)
        audio_data = io.BytesIO()
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio_data.write(chunk["data"])
        audio_data.seek(0)
        return StreamingResponse(audio_data, media_type="audio/mpeg")
    except ImportError:
        from fastapi import HTTPException
        raise HTTPException(503, "TTS 服务未安装（需要 pip install edge_tts）")
    except Exception as exc:                      # noqa: BLE001
        # 微软侧拒绝/超时不是「服务端写错了」，不该给调用方一个带完整 traceback 的 500，
        # 也不该把每次失败都当未处理异常灌进 journal（2026-10 出事时一晚上刷了十几屏）。
        # 合成失败一律 503 + 一句能看懂的原因；能不能用由 GET /api/tts/health 提前回答。
        from fastapi import HTTPException
        raise HTTPException(503, "服务端语音暂不可用（%s）" % str(exc)[:120])


@router.get("/voices")
def list_voices():
    return {"voices": VALID_VOICES}
