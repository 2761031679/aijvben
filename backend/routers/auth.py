"""认证路由"""
import uuid
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session
from ..core.database import get_db
from ..core.security import get_current_user
from ..models.user import User
from ..schemas.auth import (
    SendCodeRequest, RegisterRequest, LoginRequest,
    ChangePasswordRequest, ForgotPasswordRequest,
)
from ..services import auth_service, realname_service

router = APIRouter(prefix="/api/auth", tags=["认证"])


@router.post("/send-code")
def send_code(req: SendCodeRequest, db: Session = Depends(get_db)):
    auth_service.send_verification_code(db, req.email, req.purpose)
    return {"message": "验证码已发送"}


@router.post("/register")
def register(req: RegisterRequest, db: Session = Depends(get_db)):
    return auth_service.register(db, req.username, req.email, req.password, req.confirm_password, req.code)


@router.post("/login")
def login(req: LoginRequest, db: Session = Depends(get_db)):
    return auth_service.login(db, req.username, req.password)


@router.get("/me")
def me(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return auth_service.get_me(db, user)


@router.post("/change-password")
def change_password(req: ChangePasswordRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return auth_service.change_password(db, user, req.email, req.code, req.new_password, req.confirm_new_password)


@router.post("/forgot-password")
def forgot_password(req: ForgotPasswordRequest, db: Session = Depends(get_db)):
    return auth_service.forgot_password(db, req.email, req.code, req.new_password, req.confirm_new_password)


@router.post("/guest-token")
def guest_token():
    guest_id = uuid.uuid4().hex[:12]
    return auth_service.guest_login(None, guest_id)


@router.post("/realname-verify")
def realname_verify(payload: dict, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """发起实名认证（扫码认证 + R01 网络身份认证凭证）。

    生成认证二维码，前端展示后用户用「国家网络身份认证」App 扫码认证。
    认证结果由平台通过 /realname-callback 推送。
    """
    try:
        return realname_service.generate_qrcode(db, user.id)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"实名认证发起失败：{e}")


@router.post("/realname-callback")
async def realname_callback(request: Request, db: Session = Depends(get_db)):
    """实名认证结果推送回调（国家网络身份认证公共服务 官方回调地址）。

    官方服务在用户完成认证后，向此 URL 推送认证结果（POST，携带官方签名凭证）。
    注意：此接口【无需用户登录】，由官方以自己的签名/密钥鉴权，不依赖站内 JWT。
    接收原始 body（不依赖 FastAPI 自动反序列化），以原始 bizPackage 子串验签。

    安全边界（2026-11 审计修正）：本接口是**匿名可达**的，所以"谁来都信"是绝对不行的。
    现在 handle_callback 内部强制验签，缺 sign 直接拒绝；另外若服务器注入了
    REALNAME_CALLBACK_TOKEN，还必须带同一个 X-Callback-Token 头（纵深防御，可选）。
    """
    raw = await request.body()
    raw_str = raw.decode("utf-8")
    try:
        return realname_service.handle_callback(
            db, raw_str, callback_token=request.headers.get("x-callback-token", "")
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"实名认证回调处理失败：{e}")


@router.post("/account/delete")
def delete_account(payload: dict, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """注销账号（个人信息删除权，GB/T 35273）。需验证密码确认。"""
    return auth_service.delete_account(db, user, (payload.get("password") or "").strip())
