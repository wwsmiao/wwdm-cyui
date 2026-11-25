"""ComfyUI WebSocket 事件总线：单条长连接，把进度事件分发给对应任务。"""
import asyncio
import json
import threading
from urllib.parse import quote


class ComfyEventBus:
    def __init__(self, url_getter, client_id_getter, on_event):
        self._url_getter = url_getter
        self._client_getter = client_id_getter
        self._on_event = on_event
        self._stop = threading.Event()
        self._thread = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._runner, daemon=True,
                                        name="comfy-event-bus")
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _runner(self) -> None:
        asyncio.run(self._loop())

    async def _loop(self) -> None:
        try:
            import aiohttp
        except ImportError:
            return
        self._failed = 0
        while not self._stop.is_set():
            ws = None
            try:
                base = self._url_getter().rstrip("/")
                ws_url = base.replace("http://", "ws://", 1).replace(
                    "https://", "wss://", 1
                ) + "/ws?clientId=" + quote(self._client_getter())
                async with aiohttp.ClientSession() as session:
                    ws = await session.ws_connect(ws_url, heartbeat=15)
                    self._failed = 0
                    while not self._stop.is_set():
                        try:
                            msg = await asyncio.wait_for(ws.receive(), timeout=1.0)
                        except asyncio.TimeoutError:
                            continue
                        if msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSING,
                                        aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                            break
                        if msg.type != aiohttp.WSMsgType.TEXT:
                            continue
                        try:
                            self._on_event(json.loads(msg.data))
                        except Exception:   # 单条事件处理失败不能把长连接带崩
                            continue
            except asyncio.CancelledError:
                break
            except Exception:
                pass
            finally:
                # 主动走关闭握手：否则 ComfyUI 会把这条"半开"连接留在 sockets 里，
                # 每次广播进度都刷一条 "Cannot write to closing transport"
                if ws is not None and not ws.closed:
                    try:
                        await ws.close()
                    except Exception:
                        pass
                if not self._stop.is_set():
                    # 退避重连：断线时别每 3 秒硬连一次，ComfyUI 那边会留下半开连接
                    await asyncio.sleep(min(30, 3 * (self._failed + 1)))
                    self._failed = min(6, self._failed + 1)
