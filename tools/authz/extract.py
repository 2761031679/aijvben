"""从后端源码里抽出所有路由 + 它们各自的身份依赖（纯静态分析，不导入应用）。

为什么静态分析而不是导入 app：
导入 app 会执行 init_db()、连数据库、起种子数据 —— 校验脚本不该有这种副作用，
也不该因为数据库没起来就跑不了。
"""
import ast
import io
import os

GUARD_TO_LEVEL = {
    'get_current_user': 'user',
    'get_optional_user': 'public',          # 游客也能访问，登录了才多几个字段
    'require_admin': 'admin',
    'require_owner': 'owner',
    'require_admin_or_station_master': 'admin_or_sm',
    # 「只认人自己登录、门票不算」——用于签发/管理 AI 门票本身（审计 M2：
    # 门票若能自签，吊销就形同作废）。等级仍是 user。
    'require_login_not_token': 'user',
}
GUARD_NAMES = set(GUARD_TO_LEVEL)

# 主持证（host_token）是**另一个维度**：它不是 users 表里的角色，而是「只对这一场有效」
# 的临时凭证。所以它不参与 level 的高低比较，单独标一个布尔位。
# 认这两个调用：一个是强制验、一个是「主持证或会话主人」二选一。
HOST_TOKEN_CALLS = ('require_token', 'require_session_owner_or_token')
LEVELS = ('public', 'user', 'admin', 'owner', 'admin_or_sm')

HTTP = ('get', 'post', 'put', 'delete', 'patch')


def _router_prefix(tree):
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and getattr(node.func, 'id', None) == 'APIRouter':
            for kw in node.keywords:
                if kw.arg == 'prefix' and isinstance(kw.value, ast.Constant):
                    return kw.value.value
    return ''


def _guards_in(fn):
    """看函数签名里的默认值用了哪些鉴权依赖。"""
    found = []
    for d in list(fn.args.defaults) + [x for x in fn.args.kw_defaults if x is not None]:
        if not isinstance(d, ast.Call):
            continue
        for sub in ast.walk(d):
            if isinstance(sub, ast.Name) and sub.id in GUARD_NAMES:
                if sub.id not in found:
                    found.append(sub.id)
    return found


def _needs_host_token(fn):
    """函数体里是否强制校验主持证。看函数体而不是签名——主持证走手写 Header 解析。"""
    for node in ast.walk(fn):
        if isinstance(node, ast.Call):
            f = node.func
            name = None
            if isinstance(f, ast.Attribute):
                name = f.attr
            elif isinstance(f, ast.Name):
                name = f.id
            if name in HOST_TOKEN_CALLS:
                return True
    return False


def extract(root='backend'):
    """返回 [{method, path, file, func, line, guards, level}]，按 path 排序。"""
    routes = []
    targets = []
    for name in sorted(os.listdir(os.path.join(root, 'routers'))):
        if name.endswith('.py') and name != '__init__.py':
            targets.append(os.path.join(root, 'routers', name))
    targets.append(os.path.join(root, 'main.py'))

    for path in targets:
        src = io.open(path, encoding='utf-8').read()
        tree = ast.parse(src)
        is_main = path.endswith('main.py')
        prefix = '' if is_main else _router_prefix(tree)
        decorator_root = 'app' if is_main else 'router'

        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for dec in node.decorator_list:
                if not isinstance(dec, ast.Call):
                    continue
                f = dec.func
                if not (isinstance(f, ast.Attribute) and f.attr in HTTP):
                    continue
                if not (isinstance(f.value, ast.Name) and f.value.id == decorator_root):
                    continue
                if not dec.args or not isinstance(dec.args[0], ast.Constant):
                    routes.append({
                        'method': f.attr.upper(), 'path': '<非字面量路径>',
                        'file': path.replace('\\', '/'), 'func': node.name,
                        'line': node.lineno, 'guards': _guards_in(node), 'level': None,
                        'host_token': _needs_host_token(node),
                    })
                    continue
                guards = _guards_in(node)
                level = None
                for g in guards:
                    lv = GUARD_TO_LEVEL[g]
                    # 同一个函数里若出现多个依赖，取权限最高的那个
                    if level is None or LEVELS.index(lv) > LEVELS.index(level):
                        level = lv
                routes.append({
                    'method': f.attr.upper(),
                    'path': prefix + dec.args[0].value,
                    'file': path.replace('\\', '/'),
                    'func': node.name,
                    'line': node.lineno,
                    'guards': guards,
                    'level': level or 'public',
                    'host_token': _needs_host_token(node),
                })
    routes.sort(key=lambda r: (r['path'], r['method']))
    return routes
