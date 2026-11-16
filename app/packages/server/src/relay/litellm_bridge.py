#!/usr/bin/env python3
# Spec: knowledge/components/aeion-engine.md
"""Loopback LiteLLM bridge for Pi + Flue agents with zero-disk secret handling."""
from __future__ import annotations

import argparse
import hmac
import json
import logging
import os
import socket
import sys
import uuid
from typing import Any

import litellm
import uvicorn
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

os.environ.setdefault("LITELLM_LOG", "ERROR")
logging.getLogger("LiteLLM").setLevel(logging.ERROR)
litellm.drop_params = True
litellm.telemetry = False

app = FastAPI(title="aeion-spec-litellm-bridge")
BRIDGE_SECRET = os.environ.get("AEION_LITELLM_BRIDGE_SECRET", "")


def _check_secret(secret: str | None) -> None:
    if not BRIDGE_SECRET or not secret or not hmac.compare_digest(secret, BRIDGE_SECRET):
        raise HTTPException(status_code=401, detail="Unauthorized bridge request")


def _extract_dict(chunk: Any) -> dict[str, Any]:
    if hasattr(chunk, "model_dump"):
        return chunk.model_dump(exclude_none=True)
    if isinstance(chunk, dict):
        return chunk
    return json.loads(json.dumps(chunk, default=str))


@app.get("/health")
async def health(x_aeion_bridge_secret: str | None = Header(default=None)) -> dict[str, Any]:
    _check_secret(x_aeion_bridge_secret)
    return {"ok": True, "provider": "litellm"}


def _completion_to_sse_chunks(payload: dict[str, Any], model: str) -> list[str]:
    """Synthesize standard OpenAI SSE chunk events from a non-streaming completion."""
    cid = str(payload.get("id") or f"chatcmpl-{uuid.uuid4().hex[:12]}")
    created = int(payload.get("created") or 0)
    resolved_model = str(payload.get("model") or model)
    choices = payload.get("choices") or [{}]
    first = choices[0] if choices else {}
    msg = first.get("message") or {}
    finish = first.get("finish_reason") or "stop"

    chunks: list[dict[str, Any]] = []
    # Role + content delta
    delta_first: dict[str, Any] = {"role": "assistant"}
    if msg.get("content"):
        delta_first["content"] = msg["content"]
    chunks.append({
        "id": cid,
        "object": "chat.completion.chunk",
        "created": created,
        "model": resolved_model,
        "choices": [{"index": 0, "delta": delta_first, "finish_reason": None}],
    })

    # Normalize tool_calls so OpenAI/Pi clients always see index + type: "function"
    raw_calls = msg.get("tool_calls") or []
    if raw_calls:
        norm_calls = []
        for idx, tc in enumerate(raw_calls):
            fn = tc.get("function") or {}
            norm_calls.append({
                "index": tc.get("index", idx),
                "id": tc.get("id") or f"call_{uuid.uuid4().hex[:16]}",
                "type": tc.get("type") or "function",
                "function": {
                    "name": fn.get("name", ""),
                    "arguments": fn.get("arguments", "{}"),
                },
            })
        chunks.append({
            "id": cid,
            "object": "chat.completion.chunk",
            "created": created,
            "model": resolved_model,
            "choices": [{"index": 0, "delta": {"tool_calls": norm_calls}, "finish_reason": None}],
        })

    final_chunk: dict[str, Any] = {
        "id": cid,
        "object": "chat.completion.chunk",
        "created": created,
        "model": resolved_model,
        "choices": [{"index": 0, "delta": {}, "finish_reason": finish}],
    }
    if payload.get("usage"):
        final_chunk["usage"] = payload["usage"]
    chunks.append(final_chunk)

    lines = [f"data: {json.dumps(c, ensure_ascii=False)}\n\n" for c in chunks]
    lines.append("data: [DONE]\n\n")
    return lines


@app.post("/v1/chat/completions")
async def chat_completions(
    request: Request,
    x_aeion_bridge_secret: str | None = Header(default=None),
    x_aeion_upstream_key: str | None = Header(default=None),
    x_aeion_api_base: str | None = Header(default=None),
    x_aeion_session_id: str | None = Header(default=None),
):
    _check_secret(x_aeion_bridge_secret)
    if not x_aeion_upstream_key:
        raise HTTPException(status_code=400, detail="Missing upstream key header")

    body = await request.json()
    model = body.get("model")
    messages = body.get("messages")
    if not model or not isinstance(messages, list):
        raise HTTPException(status_code=400, detail="Missing model or messages")

    kwargs: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "api_key": x_aeion_upstream_key,
        "stream": bool(body.get("stream", False)),
    }
    if x_aeion_api_base:
        kwargs["api_base"] = x_aeion_api_base
    if str(model).startswith("opencode_go/") or x_aeion_session_id:
        kwargs["extra_headers"] = {
            "x-opencode-session": x_aeion_session_id or f"aeion-{uuid.uuid4()}"
        }
    for opt in (
        "temperature",
        "max_tokens",
        "max_completion_tokens",
        "tools",
        "tool_choice",
        "response_format",
        "reasoning_effort",
        "stream_options",
    ):
        if opt in body and body[opt] is not None:
            kwargs[opt] = body[opt]

    # Do not keep reference to x_aeion_upstream_key past completion creation
    if kwargs["stream"]:
        async def event_stream():
            emitted_any = False
            try:
                resp = await litellm.acompletion(**kwargs)
                async for chunk in resp:
                    emitted_any = True
                    payload = _extract_dict(chunk)
                    yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
                kwargs.pop("api_key", None)
                yield "data: [DONE]\n\n"
            except Exception as exc:
                # Some providers/models (e.g., Anthropic via opencode_go in litellm) fail on stream iterators;
                # fall back cleanly to non-streaming completion + SSE synthesis before any chunk is sent.
                if not emitted_any and kwargs.get("api_key"):
                    try:
                        ns_kwargs = {k: v for k, v in kwargs.items() if k != "stream_options"}
                        ns_kwargs["stream"] = False
                        ns_resp = await litellm.acompletion(**ns_kwargs)
                        kwargs.pop("api_key", None)
                        for line in _completion_to_sse_chunks(_extract_dict(ns_resp), str(model)):
                            yield line
                        return
                    except Exception as ns_exc:
                        exc = ns_exc
                kwargs.pop("api_key", None)
                err_payload = {"error": {"message": f"{type(exc).__name__}: {str(exc)[:300]}", "type": "upstream_error"}}
                yield f"data: {json.dumps(err_payload)}\n\n"
                yield "data: [DONE]\n\n"

        return StreamingResponse(event_stream(), media_type="text/event-stream")

    try:
        resp = await litellm.acompletion(**kwargs)
        kwargs.pop("api_key", None)
        return JSONResponse(_extract_dict(resp))
    except Exception as exc:
        kwargs.pop("api_key", None)
        raise HTTPException(status_code=502, detail=f"LiteLLM upstream error: {type(exc).__name__}: {str(exc)[:300]}")


@app.post("/v1/messages")
async def anthropic_messages(
    request: Request,
    x_aeion_bridge_secret: str | None = Header(default=None),
    x_aeion_upstream_key: str | None = Header(default=None),
    x_aeion_session_id: str | None = Header(default=None),
):
    _check_secret(x_aeion_bridge_secret)
    if not x_aeion_upstream_key:
        raise HTTPException(status_code=400, detail="Missing upstream key header")
    body = await request.json()
    model = body.get("model", "anthropic/claude-sonnet-4-5")
    if "/" not in str(model):
        model = f"anthropic/{model}"

    oa_messages: list[dict[str, Any]] = []
    if body.get("system"):
        sys_txt = body["system"] if isinstance(body["system"], str) else " ".join(
            p.get("text", "") for p in body["system"] if isinstance(p, dict)
        )
        if sys_txt:
            oa_messages.append({"role": "system", "content": sys_txt})
    for m in body.get("messages", []):
        role = m.get("role", "user")
        content = m.get("content", "")
        if isinstance(content, list):
            txt = "\n".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
        else:
            txt = str(content)
        oa_messages.append({"role": role, "content": txt})

    kwargs: dict[str, Any] = {
        "model": model,
        "messages": oa_messages,
        "api_key": x_aeion_upstream_key,
        "max_tokens": body.get("max_tokens", 4096),
        "stream": False,
    }
    if str(model).startswith("opencode_go/") or x_aeion_session_id:
        kwargs["extra_headers"] = {
            "x-opencode-session": x_aeion_session_id or f"aeion-{uuid.uuid4()}"
        }
    if "temperature" in body and body["temperature"] is not None:
        kwargs["temperature"] = body["temperature"]

    try:
        resp = await litellm.acompletion(**kwargs)
        kwargs.pop("api_key", None)
        data = _extract_dict(resp)
        choice = (data.get("choices") or [{}])[0]
        msg = choice.get("message") or {}
        text = msg.get("content") or ""
        usage = data.get("usage") or {}
        return JSONResponse(
            {
                "id": data.get("id", "msg_aeion"),
                "type": "message",
                "role": "assistant",
                "model": body.get("model", model),
                "content": [{"type": "text", "text": text}],
                "stop_reason": "end_turn",
                "usage": {
                    "input_tokens": usage.get("prompt_tokens", 0),
                    "output_tokens": usage.get("completion_tokens", 0),
                },
            }
        )
    except Exception as exc:
        kwargs.pop("api_key", None)
        raise HTTPException(status_code=502, detail=f"LiteLLM upstream error: {type(exc).__name__}: {str(exc)[:300]}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", args.port))
    bound_port = sock.getsockname()[1]
    sock.close()

    sys.stdout.write(json.dumps({"ready": True, "port": bound_port}) + "\n")
    sys.stdout.flush()
    uvicorn.run(app, host="127.0.0.1", port=bound_port, log_level="warning")


if __name__ == "__main__":
    main()
