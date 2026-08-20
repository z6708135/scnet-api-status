#!/usr/bin/env python3
"""Run one real SCNet streaming chat probe and publish sanitized metrics.

Required environment variable:
  SCNET_API_KEY       A regular sk- API key that permits server-side automation.

Optional environment variables:
  STATUS_JSON_PATH    Static status file to update (default: docs/status.json).
  STATUS_INGEST_URL   Optional remote status API.
  STATUS_INGEST_TOKEN Bearer token required when STATUS_INGEST_URL is set.

Token Plan keys (sk-tp-) are refused because SCNet limits them to interactive
AI tools and does not permit automated scripts or public application backends.
"""

from __future__ import annotations

import json
import os
import statistics
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any


BASE_URL = "https://api.scnet.cn/api/llm/v1"
MODEL = "DeepSeek-V4-Flash-0731"
PROMPT = "Hello world"


def env_required(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"missing required environment variable: {name}")
    return value


def http_error(exc: BaseException) -> tuple[int | None, str]:
    if isinstance(exc, urllib.error.HTTPError):
        try:
            payload = json.loads(exc.read(4096).decode("utf-8", errors="replace"))
            error = payload.get("error", {}) if isinstance(payload, dict) else {}
            return exc.code, str(error.get("code") or error.get("message") or f"HTTP {exc.code}")[:160]
        except Exception:
            return exc.code, f"HTTP {exc.code}"
    return None, type(exc).__name__


def run_probe(api_key: str, timeout: float = 90.0) -> dict[str, Any]:
    started = time.perf_counter()
    body = json.dumps({
        "model": MODEL,
        "messages": [
            {"role": "system", "content": "Reply naturally and concisely. Keep the answer under 80 words."},
            {"role": "user", "content": PROMPT},
        ],
        "temperature": 0.2,
        "max_tokens": 160,
        "stream": True,
        "stream_options": {"include_usage": True},
    }).encode("utf-8")
    request = urllib.request.Request(
        f"{BASE_URL}/chat/completions",
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
            "User-Agent": "scnet-community-status/1.0",
        },
    )
    checked_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    result: dict[str, Any] = {
        "checkedAt": checked_at,
        "endpointOk": False,
        "inferenceOk": False,
        "httpStatus": None,
        "latencyMs": None,
        "ttftMs": None,
        "outputTokens": None,
        "outputTps": None,
        "truncated": None,
        "model": MODEL,
        "errorCode": None,
    }
    try:
        response = urllib.request.urlopen(request, timeout=timeout)
        result["endpointOk"] = True
        result["httpStatus"] = response.status
        ttft_ms: float | None = None
        output_tokens: int | None = None
        finish_reason: str | None = None
        has_content = False
        with response:
            while True:
                line = response.readline()
                if not line:
                    break
                if not line.startswith(b"data:"):
                    continue
                data = line[5:].strip()
                if not data or data == b"[DONE]":
                    continue
                try:
                    event = json.loads(data)
                except json.JSONDecodeError:
                    continue
                choices = event.get("choices", []) if isinstance(event, dict) else []
                if choices:
                    choice = choices[0]
                    delta = choice.get("delta", {})
                    token = delta.get("content") or delta.get("reasoning_content")
                    if token and ttft_ms is None:
                        ttft_ms = (time.perf_counter() - started) * 1000
                    if delta.get("content"):
                        has_content = True
                    if choice.get("finish_reason"):
                        finish_reason = str(choice["finish_reason"])
                usage = event.get("usage") if isinstance(event, dict) else None
                if isinstance(usage, dict) and isinstance(usage.get("completion_tokens"), int):
                    output_tokens = usage["completion_tokens"]
        total_ms = (time.perf_counter() - started) * 1000
        result.update({
            "inferenceOk": response.status == 200 and has_content and ttft_ms is not None,
            "latencyMs": round(total_ms),
            "ttftMs": round(ttft_ms) if ttft_ms is not None else None,
            "outputTokens": output_tokens,
            "truncated": finish_reason == "length" if finish_reason else None,
        })
        if output_tokens is not None and ttft_ms is not None:
            generation_seconds = max((total_ms - ttft_ms) / 1000, 0.001)
            result["outputTps"] = round(output_tokens / generation_seconds, 2)
        if not result["inferenceOk"]:
            result["errorCode"] = "empty_or_invalid_stream"
    except Exception as exc:
        status, code = http_error(exc)
        result["httpStatus"] = status
        result["latencyMs"] = round((time.perf_counter() - started) * 1000)
        result["errorCode"] = code
    return result


def publish(result: dict[str, Any], url: str, token: str, timeout: float = 30.0) -> None:
    request = urllib.request.Request(
        url,
        data=json.dumps(result).encode("utf-8"),
        method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", "User-Agent": "scnet-community-status/1.0"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        if response.status != 202:
            raise RuntimeError(f"status publisher returned HTTP {response.status}")


def percentile(values: list[float], ratio: float) -> float | None:
    if not values:
        return None
    values = sorted(values)
    position = (len(values) - 1) * ratio
    lower = int(position)
    upper = min(lower + 1, len(values) - 1)
    fraction = position - lower
    return values[lower] + (values[upper] - values[lower]) * fraction


def update_status_file(result: dict[str, Any], path: str) -> None:
    current: dict[str, Any] = {"checks": [], "summary": None}
    try:
        with open(path, "r", encoding="utf-8") as handle:
            loaded = json.load(handle)
            if isinstance(loaded, dict):
                current = loaded
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    checks = [result, *[item for item in current.get("checks", []) if isinstance(item, dict)]]
    cutoff = datetime.now(timezone.utc).timestamp() - 30 * 24 * 60 * 60
    checks = [item for item in checks if _timestamp(item.get("checkedAt")) >= cutoff][:720]
    inference = [item for item in checks if item.get("inferenceOk") is not None]
    successes = [item for item in inference if item.get("inferenceOk") is True]
    latencies = [float(item["latencyMs"]) for item in successes if isinstance(item.get("latencyMs"), (int, float))]
    ttfts = [float(item["ttftMs"]) for item in successes if isinstance(item.get("ttftMs"), (int, float))]
    speeds = [float(item["outputTps"]) for item in successes if isinstance(item.get("outputTps"), (int, float))]
    summary = None
    if inference:
        summary = {
            "samples": len(inference),
            "successes": len(successes),
            "uptimePct": round(100 * len(successes) / len(inference), 4),
            "p50Ms": round(percentile(latencies, 0.50), 2) if latencies else None,
            "p95Ms": round(percentile(latencies, 0.95), 2) if latencies else None,
            "avgTtftMs": round(statistics.fmean(ttfts), 2) if ttfts else None,
            "avgOutputTps": round(statistics.fmean(speeds), 2) if speeds else None,
            "truncations": sum(item.get("truncated") is True for item in inference),
        }
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    temporary = f"{path}.tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump({"checks": checks, "summary": summary}, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    os.replace(temporary, path)


def _timestamp(value: Any) -> float:
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return 0


def main() -> int:
    try:
        api_key = env_required("SCNET_API_KEY")
        if api_key.startswith("sk-tp-"):
            raise RuntimeError("refusing sk-tp- Token Plan key; use a regular sk- key authorized for automation")
        result = run_probe(api_key)
        status_path = os.getenv("STATUS_JSON_PATH", "docs/status.json")
        update_status_file(result, status_path)
        ingest_url = os.getenv("STATUS_INGEST_URL", "").strip()
        if ingest_url:
            publish(result, ingest_url, env_required("STATUS_INGEST_TOKEN"))
        print(json.dumps({"recorded": True, "statusPath": status_path, **result}, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(f"monitor failed: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
