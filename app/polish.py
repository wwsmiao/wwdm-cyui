# -*- coding: utf-8 -*-
"""提示词润色 / 反推 / DeepSeek 远程调用

本地通道走 `llm.py`（ComfyUI TextGenerateV2 + qwen3vl_4b），
远程通道走 DeepSeek chat API（反推用视觉模型 deepseek-v4-flash-vision-exp）。
两边的系统提示词共用全局设置里的那一份。
"""
import base64
import time

import requests

from . import comfy, llm

DEFAULT_VISION_MODEL = "deepseek-v4-flash-vision-exp"


# ---------------------------------------------------------------- 本地工作流
def polish_local(prompt, cfg=None, images=None, mode=None):
    """本地 ComfyUI 文本工作流润色；带参考图时走多模态（图生图 / 编辑 / 局部重绘）"""
    text, _cost = llm.polish(prompt, cfg, images=images, mode=mode)
    return text


def reverse_prompt(image, hint="", cfg=None):
    """本地单图反推，返回 (文本, 耗时秒)"""
    return llm.reverse(image, hint, cfg)


# ---------------------------------------------------------------- DeepSeek
def _deepseek_headers(api_key):
    return {"Authorization": "Bearer " + api_key, "Content-Type": "application/json"}


def list_deepseek_models(api_key):
    """拉取 DeepSeek 可用模型列表（GET /models）"""
    s = requests.Session()
    s.trust_env = False
    try:
        r = s.get("https://api.deepseek.com/models",
                  headers=_deepseek_headers(api_key), timeout=30)
    except Exception as e:
        raise comfy.ComfyError("DeepSeek 请求失败：%s" % str(e)[:160])
    if r.status_code != 200:
        raise comfy.ComfyError("DeepSeek 返回 %d：%s" % (r.status_code, r.text[:200]))
    try:
        data = r.json()
        ids = [m.get("id") for m in (data.get("data") or []) if m.get("id")]
    except Exception as e:
        raise comfy.ComfyError("返回解析失败：%s" % str(e)[:120])
    if not ids:
        raise comfy.ComfyError("未获取到模型")
    comfy.log("DeepSeek 模型列表获取成功（%d 个）" % len(ids), "OK")
    return ids


def polish_deepseek(prompt, api_key, model="deepseek-chat", cfg=None, images=None, mode=None):
    """远程 DeepSeek 润色（系统提示词与本地工作流保持一致）。
    带参考图时自动切换视觉模型，把图片与提示词一起发给模型。"""
    s = requests.Session()
    s.trust_env = False

    imgs = [x for x in (images or []) if x][:2]
    content = prompt
    if imgs:
        # deepseek-chat 不支持视觉：带图时切到视觉模型
        if not (model or "").strip() or "vision" not in model.lower():
            model = DEFAULT_VISION_MODEL
        parts = [{"type": "text", "text": prompt}]
        for name in imgs:
            try:
                raw = comfy.view(name, "", "input")
            except Exception as e:
                raise comfy.ComfyError("读取参考图失败：%s" % str(e)[:120])
            low = (name or "").lower()
            mime = "image/jpeg" if low.endswith((".jpg", ".jpeg")) else (
                "image/webp" if low.endswith(".webp") else "image/png")
            b64 = base64.b64encode(raw).decode("ascii")
            parts.append({"type": "image_url",
                          "image_url": {"url": "data:%s;base64,%s" % (mime, b64), "detail": "original"}})
        content = parts

    try:
        r = s.post(
            "https://api.deepseek.com/chat/completions",
            headers=_deepseek_headers(api_key),
            json={
                "model": model or "deepseek-chat",
                "messages": [
                    {"role": "system", "content": llm.polish_system(prompt, cfg, mode)},
                    {"role": "user", "content": content},
                ],
                "temperature": 0.7,
                "stream": False,
            },
            timeout=120,
        )
    except Exception as e:
        raise comfy.ComfyError("DeepSeek 请求失败：%s" % str(e)[:160])
    if r.status_code != 200:
        raise comfy.ComfyError("DeepSeek 返回 %d：%s" % (r.status_code, r.text[:200]))
    try:
        data = r.json()
        text = (data.get("choices") or [{}])[0].get("message", {}).get("content", "").strip()
    except Exception as e:
        raise comfy.ComfyError("DeepSeek 返回解析失败：%s" % str(e)[:120])
    if not text:
        raise comfy.ComfyError("DeepSeek 未返回文本")
    comfy.log("DeepSeek 润色完成（%d 字）" % len(text), "OK")
    return text, None


def reverse_deepseek(image, api_key, model="", cfg=None, hint=""):
    """DeepSeek 视觉反推：图片走 base64 内联，返回 (文本, 耗时秒)"""
    if not api_key:
        raise comfy.ComfyError("请先在全局设置里填写 DeepSeek API Key")
    model = (model or "").strip()
    if not model or "vision" not in model.lower():
        model = DEFAULT_VISION_MODEL

    try:
        raw = comfy.view(image, "", "input")
    except Exception as e:
        raise comfy.ComfyError("读取图片失败：%s" % str(e)[:120])
    low = (image or "").lower()
    mime = "image/jpeg" if low.endswith((".jpg", ".jpeg")) else ("image/webp" if low.endswith(".webp") else "image/png")
    b64 = base64.b64encode(raw).decode("ascii")

    cfg = cfg or {}
    systems = dict((llm.settings().get("systems") or {}))
    if isinstance(cfg.get("systems"), dict):
        systems.update({k: v for k, v in cfg["systems"].items() if isinstance(v, str) and v.strip()})
    system = systems.get("reverse") or llm.DEFAULT_REVERSE_SYSTEM
    text_prompt = (hint or "").strip() or "请反推这张图片的画面提示词。"

    t0 = time.time()
    s = requests.Session()
    s.trust_env = False
    try:
        r = s.post(
            "https://api.deepseek.com/chat/completions",
            headers=_deepseek_headers(api_key),
            json={
                "model": model,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": [
                        {"type": "text", "text": text_prompt},
                        {"type": "image_url",
                         "image_url": {"url": "data:%s;base64,%s" % (mime, b64), "detail": "original"}},
                    ]},
                ],
                "temperature": 0.7,
                "stream": False,
            },
            timeout=180,
        )
    except Exception as e:
        raise comfy.ComfyError("DeepSeek 请求失败：%s" % str(e)[:160])
    if r.status_code != 200:
        body = r.text[:300]
        if "does not support image" in body or "vision" in body.lower():
            raise comfy.ComfyError("当前 DeepSeek 模型不支持图片：请在全局设置把「反推视觉模型」改为 %s" % DEFAULT_VISION_MODEL)
        raise comfy.ComfyError("DeepSeek 返回 %d：%s" % (r.status_code, body))
    try:
        data = r.json()
        text = (data.get("choices") or [{}])[0].get("message", {}).get("content", "").strip()
    except Exception as e:
        raise comfy.ComfyError("DeepSeek 返回解析失败：%s" % str(e)[:120])
    if not text:
        raise comfy.ComfyError("DeepSeek 未返回文本")
    comfy.log("DeepSeek 反推完成（%d 字）" % len(text), "OK")
    return text, round(time.time() - t0, 1)
