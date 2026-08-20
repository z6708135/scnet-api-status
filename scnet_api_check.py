#!/usr/bin/env python3
"""Check availability and latency of SCNet's OpenAI-compatible LLM API.

The API key is read from SCNET_API_KEY (preferred) or OPENAI_API_KEY.
It is never written to reports or printed to the terminal.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import socket
import ssl
import statistics
import sys
import time
import http.client
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any


DEFAULT_BASE_URL = "https://api.scnet.cn/api/llm/v1"
USER_AGENT = "scnet-api-check/1.0"
TOKEN_PLAN_DOC = "https://www.scnet.cn/ac/openapi/doc/2.0/moduleapi/plans/token-plan.html"


@dataclass
class CheckResult:
    name: str
    ok: bool
    latency_ms: float
    status: int | None = None
    detail: str = ""
    model: str | None = None
    ttft_ms: float | None = None
    request_id: str | None = None


class ApiClient:
    def __init__(self, base_url: str, api_key: str, timeout: float, retries: int) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout
        self.retries = retries

    def request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        *,
        stream: bool = False,
    ) -> tuple[int, dict[str, str], bytes | Any, float]:
        url = f"{self.base_url}/{path.lstrip('/')}"
        data = None if payload is None else json.dumps(payload).encode("utf-8")
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Accept": "text/event-stream" if stream else "application/json",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        }
        started = time.perf_counter()
        for attempt in range(self.retries + 1):
            request = urllib.request.Request(url, data=data, headers=headers, method=method)
            try:
                response = urllib.request.urlopen(request, timeout=self.timeout)
                elapsed_ms = (time.perf_counter() - started) * 1000
                response_headers = {k.lower(): v for k, v in response.headers.items()}
                response_headers["x-check-retries"] = str(attempt)
                if stream:
                    return response.status, response_headers, response, elapsed_ms
                with response:
                    return response.status, response_headers, response.read(), elapsed_ms
            except urllib.error.HTTPError as exc:
                if exc.code not in {429, 500, 502, 503, 504} or attempt >= self.retries:
                    raise
                exc.close()
            except (
                urllib.error.URLError,
                TimeoutError,
                socket.timeout,
                ssl.SSLError,
                http.client.RemoteDisconnected,
            ):
                if attempt >= self.retries:
                    raise
            time.sleep(min(0.5 * (2**attempt), 4.0))
        raise RuntimeError("retry loop ended unexpectedly")


def retry_note(headers: dict[str, str]) -> str:
    retries = int(headers.get("x-check-retries", "0"))
    return f", succeeded after {retries} retr{'y' if retries == 1 else 'ies'}" if retries else ""


def safe_error(exc: BaseException) -> tuple[int | None, str]:
    """Return a useful error without leaking request headers or credentials."""
    if isinstance(exc, urllib.error.HTTPError):
        try:
            raw = exc.read(4096).decode("utf-8", errors="replace")
            parsed = json.loads(raw)
            error = parsed.get("error", parsed) if isinstance(parsed, dict) else parsed
            if isinstance(error, dict):
                message = str(error.get("message") or error.get("code") or error)
            else:
                message = str(error)
        except Exception:
            message = exc.reason if isinstance(exc.reason, str) else "HTTP error"
        return exc.code, message[:500]
    if isinstance(exc, urllib.error.URLError):
        return None, f"network error: {exc.reason}"
    if isinstance(exc, (TimeoutError, socket.timeout)):
        return None, "request timed out"
    return None, f"{type(exc).__name__}: {exc}"


def percentile(values: list[float], p: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * p
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    fraction = position - lower
    return ordered[lower] + (ordered[upper] - ordered[lower]) * fraction


def get_models(client: ApiClient) -> tuple[CheckResult, list[str]]:
    started = time.perf_counter()
    try:
        status, headers, body, latency = client.request("GET", "models")
        payload = json.loads(body)
        data = payload.get("data", []) if isinstance(payload, dict) else []
        models = [str(item["id"]) for item in data if isinstance(item, dict) and item.get("id")]
        detail = f"found {len(models)} model(s){retry_note(headers)}"
        if not models:
            detail = "authenticated, but the response contained no model IDs"
        return (
            CheckResult(
                name="models",
                ok=status == 200 and bool(models),
                latency_ms=latency,
                status=status,
                detail=detail,
                request_id=headers.get("x-request-id"),
            ),
            models,
        )
    except Exception as exc:
        status, detail = safe_error(exc)
        return (
            CheckResult(
                name="models",
                ok=False,
                latency_ms=(time.perf_counter() - started) * 1000,
                status=status,
                detail=detail,
            ),
            [],
        )


def select_model(requested: str | None, models: list[str]) -> str | None:
    if requested:
        return requested
    if not models:
        return None
    preferred = (
        "deepseek-v4-flash-0731",
        "auto",
        "glm-5.2",
        "minimax-m2.5",
        "deepseek-v4-flash",
        "kimi-k2.5",
        "deepseek-v3.1",
        "deepseek-v3",
        "deepseek-chat",
    )
    lower_to_original = {model.lower(): model for model in models}
    for candidate in preferred:
        if candidate in lower_to_original:
            return lower_to_original[candidate]
    return models[0]


def chat_once(client: ApiClient, model: str, index: int, max_tokens: int) -> CheckResult:
    started = time.perf_counter()
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": "只回复：OK"}],
        "temperature": 0,
        "max_tokens": max_tokens,
        "stream": False,
    }
    try:
        status, headers, body, latency = client.request("POST", "chat/completions", payload)
        parsed = json.loads(body)
        choices = parsed.get("choices", []) if isinstance(parsed, dict) else []
        content = ""
        if choices and isinstance(choices[0], dict):
            message = choices[0].get("message", {})
            if isinstance(message, dict):
                content = str(message.get("content") or "")
        usage = parsed.get("usage", {}) if isinstance(parsed, dict) else {}
        total_tokens = usage.get("total_tokens") if isinstance(usage, dict) else None
        detail = f"valid completion{retry_note(headers)}"
        if total_tokens is not None:
            detail += f", total_tokens={total_tokens}"
        if not content:
            detail = "HTTP 200 but completion content was empty"
        return CheckResult(
            name=f"chat-{index}",
            ok=status == 200 and bool(content),
            latency_ms=latency,
            status=status,
            detail=detail,
            model=model,
            request_id=headers.get("x-request-id"),
        )
    except Exception as exc:
        status, detail = safe_error(exc)
        return CheckResult(
            name=f"chat-{index}",
            ok=False,
            latency_ms=(time.perf_counter() - started) * 1000,
            status=status,
            detail=detail,
            model=model,
        )


def stream_once(client: ApiClient, model: str, max_tokens: int) -> CheckResult:
    started = time.perf_counter()
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": "只回复：OK"}],
        "temperature": 0,
        "max_tokens": max_tokens,
        "stream": True,
    }
    response = None
    try:
        status, headers, response, headers_ms = client.request(
            "POST", "chat/completions", payload, stream=True
        )
        first_data_ms = None
        has_content = False
        while True:
            line = response.readline()
            if not line:
                break
            if not line.startswith(b"data:"):
                continue
            data = line[5:].strip()
            if not data or data == b"[DONE]":
                continue
            if first_data_ms is None:
                first_data_ms = (time.perf_counter() - started) * 1000
            try:
                event = json.loads(data)
                choices = event.get("choices", [])
                if choices:
                    delta = choices[0].get("delta", {})
                    if delta.get("content"):
                        has_content = True
            except (json.JSONDecodeError, AttributeError, TypeError):
                pass
        total_ms = (time.perf_counter() - started) * 1000
        return CheckResult(
            name="stream",
            ok=status == 200 and first_data_ms is not None and has_content,
            latency_ms=total_ms,
            status=status,
            ttft_ms=first_data_ms,
            detail=f"headers in {headers_ms:.0f} ms; stream completed{retry_note(headers)}",
            model=model,
            request_id=headers.get("x-request-id"),
        )
    except Exception as exc:
        status, detail = safe_error(exc)
        return CheckResult(
            name="stream",
            ok=False,
            latency_ms=(time.perf_counter() - started) * 1000,
            status=status,
            detail=detail,
            model=model,
        )
    finally:
        if response is not None:
            response.close()


def make_summary(results: list[CheckResult]) -> dict[str, Any]:
    chat_results = [item for item in results if item.name.startswith("chat-")]
    successes = [item for item in chat_results if item.ok]
    latencies = [item.latency_ms for item in successes]
    return {
        "checks_total": len(results),
        "checks_passed": sum(item.ok for item in results),
        "chat_requests": len(chat_results),
        "chat_success_rate_pct": round(100 * len(successes) / len(chat_results), 2)
        if chat_results
        else None,
        "chat_latency_ms": {
            "min": round(min(latencies), 2) if latencies else None,
            "mean": round(statistics.fmean(latencies), 2) if latencies else None,
            "p50": round(percentile(latencies, 0.50), 2) if latencies else None,
            "p95": round(percentile(latencies, 0.95), 2) if latencies else None,
            "max": round(max(latencies), 2) if latencies else None,
        },
    }


def rating(summary: dict[str, Any], results: list[CheckResult]) -> tuple[int, str]:
    models_ok = any(item.name == "models" and item.ok for item in results)
    chat_rate = summary.get("chat_success_rate_pct")
    p95 = summary.get("chat_latency_ms", {}).get("p95")
    if not models_ok:
        return 0, "不可用：模型列表/鉴权检查失败"
    if chat_rate is None:
        return 1, "部分可用：鉴权成功，但未执行生成测试"
    if chat_rate < 100:
        return 1, "不稳定：至少一次生成请求失败"
    if p95 is not None and p95 <= 3000:
        return 3, "良好：请求全部成功且延迟较低"
    if p95 is not None and p95 <= 10000:
        return 2, "可用：请求全部成功，延迟一般"
    return 1, "可用但偏慢：请求成功，延迟较高"


def print_human(report: dict[str, Any]) -> None:
    print(f"SCNet API availability report ({report['timestamp']})")
    print(f"Base URL: {report['base_url']}")
    print(f"Model: {report.get('selected_model') or '-'}")
    print()
    for item in report["results"]:
        mark = "PASS" if item["ok"] else "FAIL"
        status = item["status"] if item["status"] is not None else "-"
        extra = f", TTFT {item['ttft_ms']:.0f} ms" if item["ttft_ms"] is not None else ""
        print(
            f"[{mark}] {item['name']}: HTTP {status}, {item['latency_ms']:.0f} ms"
            f"{extra} - {item['detail']}"
        )
    summary = report["summary"]
    print()
    print(f"Result: {report['rating']['label']} ({report['rating']['score']}/3)")
    if summary["chat_success_rate_pct"] is not None:
        print(f"Chat success rate: {summary['chat_success_rate_pct']:.2f}%")
        latency = summary["chat_latency_ms"]
        if latency["mean"] is not None:
            print(
                f"Chat latency: mean {latency['mean']:.0f} ms, "
                f"p50 {latency['p50']:.0f} ms, p95 {latency['p95']:.0f} ms"
            )
        else:
            print("Chat latency: unavailable (no successful chat requests)")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default=os.getenv("SCNET_BASE_URL", DEFAULT_BASE_URL))
    parser.add_argument("--api-key", default=None, help="Prefer SCNET_API_KEY instead of this option")
    parser.add_argument("--model", help="Model ID; default: auto-select from /models")
    parser.add_argument("--runs", type=int, default=3, help="Sequential generation checks (default: 3)")
    parser.add_argument(
        "--concurrency", type=int, default=0, help="Additional parallel checks; 0 disables them"
    )
    parser.add_argument("--stream", action="store_true", help="Also measure streaming TTFT")
    parser.add_argument("--skip-chat", action="store_true", help="Only test authentication/model listing")
    parser.add_argument("--max-tokens", type=int, default=8)
    parser.add_argument("--timeout", type=float, default=60.0)
    parser.add_argument(
        "--retries", type=int, default=2, help="Retries for network/429/5xx errors (default: 2)"
    )
    parser.add_argument("--json", action="store_true", help="Print JSON instead of human-readable output")
    parser.add_argument("--output", help="Write a sanitized JSON report to this path")
    args = parser.parse_args()
    if (
        args.runs < 0
        or args.concurrency < 0
        or args.retries < 0
        or args.max_tokens < 1
        or args.timeout <= 0
    ):
        parser.error("runs/concurrency/retries must be >= 0; max-tokens and timeout must be > 0")
    return args


def main() -> int:
    args = parse_args()
    api_key = args.api_key or os.getenv("SCNET_API_KEY") or os.getenv("OPENAI_API_KEY")
    if not api_key:
        print("Error: set SCNET_API_KEY before running this checker.", file=sys.stderr)
        return 2
    if api_key.startswith("sk-tp-"):
        print(
            "Token Plan key detected (sk-tp-). Configuration format is valid, but no network "
            "request was sent.\n"
            "SCNet's Token Plan rules prohibit scripted/API diagnostic calls and allow this "
            "key only in supported interactive AI tools. Configure it in Codex, Claude Code, "
            "Cursor, OpenClaw, or another listed tool instead.\n"
            f"Policy: {TOKEN_PLAN_DOC}",
            file=sys.stderr,
        )
        return 3

    client = ApiClient(args.base_url, api_key, args.timeout, args.retries)
    results: list[CheckResult] = []
    models_result, models = get_models(client)
    results.append(models_result)
    selected_model = select_model(args.model, models)

    if not args.skip_chat:
        if not selected_model:
            results.append(
                CheckResult(
                    name="chat",
                    ok=False,
                    latency_ms=0,
                    detail="no model selected; use --model if /models is unavailable",
                )
            )
        else:
            for index in range(1, args.runs + 1):
                results.append(chat_once(client, selected_model, index, args.max_tokens))
            if args.concurrency:
                first_index = args.runs + 1
                with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as executor:
                    futures = [
                        executor.submit(
                            chat_once, client, selected_model, first_index + index, args.max_tokens
                        )
                        for index in range(args.concurrency)
                    ]
                    results.extend(future.result() for future in futures)
            if args.stream:
                results.append(stream_once(client, selected_model, args.max_tokens))

    summary = make_summary(results)
    score, label = rating(summary, results)
    report = {
        "timestamp": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "base_url": args.base_url,
        "selected_model": selected_model,
        "models_count": len(models),
        "models": models,
        "results": [asdict(item) for item in results],
        "summary": summary,
        "rating": {"score": score, "max_score": 3, "label": label},
    }

    if args.output:
        with open(args.output, "w", encoding="utf-8") as handle:
            json.dump(report, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print_human(report)

    return 0 if all(item.ok for item in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
