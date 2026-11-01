"""STT 语音识别路由（Vosk 离线识别，作为浏览器 SpeechRecognition 的兜底）。

浏览器不支持 SpeechRecognition（如 Firefox）时，前端录音并上传 WAV 到此接口。
模型在服务器本地推理，用户端无需下载任何数据包。
"""
import json
import os
from fastapi import APIRouter, UploadFile, File, HTTPException

router = APIRouter(prefix="/api/stt", tags=["STT"])

# Vosk 中文小模型目录（服务器部署时下载解压到此处）
MODEL_PATH = os.environ.get("VOSK_MODEL_PATH", "data/vosk-model-small-cn-0.22")

_model = None
_model_ready = False
_model_error = ""


def _load_model():
    """懒加载 Vosk 模型（约 40MB，首次加载需数秒），全局缓存。"""
    global _model, _model_ready, _model_error
    if _model_ready:
        return _model
    try:
        from vosk import Model
        if not os.path.isdir(MODEL_PATH):
            _model_error = f"模型目录不存在：{MODEL_PATH}"
            return None
        _model = Model(MODEL_PATH)
        _model_ready = True
        return _model
    except ImportError:
        _model_error = "vosk 未安装（pip install vosk）"
    except Exception as e:  # noqa: BLE001
        _model_error = str(e)
    return None


@router.post("")
async def recognize(file: UploadFile = File(...)):
    """接收 WAV 音频（16kHz 单声道 PCM），返回识别文本。"""
    model = _load_model()
    if model is None:
        raise HTTPException(503, f"语音识别服务未就绪：{_model_error}")
    try:
        from vosk import KaldiRecognizer
        audio = await file.read()
        if not audio:
            return {"text": ""}
        rec = KaldiRecognizer(model, 16000)
        rec.AcceptWaveform(audio)
        result = json.loads(rec.FinalResult())
        return {"text": (result.get("text") or "").strip()}
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"识别失败：{e}")


@router.get("/status")
def status():
    """语音识别服务状态（供前端判断离线兜底是否可用）。"""
    _load_model()
    return {"ready": _model_ready, "error": _model_error}


# 语音识别（STT）引擎列表：系统当前支持的识别引擎。
# 后续接入第三方 API 识别（豆包、火山引擎等）时，在此追加即可，前端设置页动态展示。
STT_PROVIDERS = [
    {"id": "vosk", "name": "Vosk 离线识别（服务器）"},
]


@router.get("/providers")
def list_providers():
    """返回系统当前支持的语音识别引擎列表（前端设置页动态渲染，支持多少显示多少）。"""
    return {"providers": STT_PROVIDERS}
