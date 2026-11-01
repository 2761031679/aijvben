"""认证相关 Pydantic 模型"""
from pydantic import BaseModel, Field


class SendCodeRequest(BaseModel):
    email: str = Field(..., max_length=120)
    purpose: str = Field(default="register")


class RegisterRequest(BaseModel):
    username: str = Field(..., min_length=2, max_length=16)
    email: str = Field(..., max_length=120)
    password: str = Field(..., min_length=6, max_length=100)
    confirm_password: str = Field(..., min_length=6, max_length=100)
    code: str = Field(..., min_length=6, max_length=6)


class LoginRequest(BaseModel):
    username: str
    password: str


class ChangePasswordRequest(BaseModel):
    email: str = Field(..., max_length=120)
    code: str = Field(..., min_length=6, max_length=6)
    new_password: str = Field(..., min_length=6, max_length=100)
    confirm_new_password: str = Field(..., min_length=6, max_length=100)


class ForgotPasswordRequest(BaseModel):
    email: str = Field(..., max_length=120)
    code: str = Field(..., min_length=6, max_length=6)
    new_password: str = Field(..., min_length=6, max_length=100)
    confirm_new_password: str = Field(..., min_length=6, max_length=100)


class AuthResponse(BaseModel):
    token: str
    user: dict


class GuestTokenResponse(BaseModel):
    token: str
    guest_id: str
