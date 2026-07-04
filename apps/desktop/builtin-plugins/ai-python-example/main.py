from __future__ import annotations

import json
import os
import threading
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


BRIDGE_URL = os.environ.get("LINGFANG_PLUGIN_BRIDGE_URL", "").rstrip("/")
BRIDGE_SECRET = os.environ.get("LINGFANG_PLUGIN_BRIDGE_TOKEN", "")
HOST = "127.0.0.1"


class DemoState:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.busy = ""
        self.error = ""
        self.chat = ""
        self.image = ""

    def snapshot(self) -> dict[str, str]:
        with self.lock:
            return {
                "busy": self.busy,
                "error": self.error,
                "chat": self.chat,
                "image": self.image,
            }

    def start(self, kind: str) -> None:
        with self.lock:
            self.busy = kind
            self.error = ""

    def finish(self, kind: str, value: str) -> None:
        with self.lock:
            if kind == "chat":
                self.chat = value
            if kind == "image":
                self.image = value
            self.busy = ""
            self.error = ""

    def fail(self, message: str) -> None:
        with self.lock:
            self.busy = ""
            self.error = message


STATE = DemoState()


def bridge_request(path: str, payload: dict) -> dict:
    if not BRIDGE_URL or not BRIDGE_SECRET:
        raise RuntimeError("平台桥未就绪，请从灵坊桌面端运行该插件。")
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        f"{BRIDGE_URL}{path}",
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-LingFang-Plugin-Token": BRIDGE_SECRET,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            return json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        try:
            data = json.loads(detail)
            raise RuntimeError(data.get("message") or data.get("error") or f"HTTP {error.code}") from error
        except json.JSONDecodeError as parse_error:
            raise RuntimeError(f"HTTP {error.code}") from parse_error


def run_chat(prompt: str, model: str) -> None:
    STATE.start("chat")
    try:
        data = bridge_request(
            "/llm/chat",
            {
                "model": "premium" if model == "premium" else "fast",
                "messages": [{"role": "user", "content": prompt}],
            },
        )
        STATE.finish("chat", str(data.get("content") or "平台返回为空"))
    except Exception as error:
        STATE.fail(str(error))


def run_image(prompt: str, model: str) -> None:
    STATE.start("image")
    try:
        data = bridge_request(
            "/image/generate",
            {
                "model": "premium" if model == "premium" else "fast",
                "prompt": prompt,
                "n": 1,
                "size": "1024x1024",
            },
        )
        images = data.get("images") if isinstance(data, dict) else []
        image = images[0] if isinstance(images, list) and images else ""
        if not image:
            raise RuntimeError("平台未返回图片。")
        STATE.finish("image", str(image))
    except Exception as error:
        STATE.fail(str(error))


class DemoHandler(BaseHTTPRequestHandler):
    def log_message(self, _format: str, *_args) -> None:
        return

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/":
            self.send_html(PAGE)
            return
        if parsed.path == "/state":
            self.send_json(STATE.snapshot())
            return
        self.send_error(404)

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        prompt = (params.get("prompt") or [""])[0].strip()
        model = (params.get("model") or ["fast"])[0].strip()

        if parsed.path == "/chat":
            if not prompt:
                self.send_json({"ok": False, "message": "请输入提示词。"}, 400)
                return
            threading.Thread(target=run_chat, args=(prompt, model), daemon=True).start()
            self.send_json({"ok": True})
            return

        if parsed.path == "/image":
            if not prompt:
                self.send_json({"ok": False, "message": "请输入画面描述。"}, 400)
                return
            threading.Thread(target=run_image, args=(prompt, model), daemon=True).start()
            self.send_json({"ok": True})
            return

        self.send_error(404)

    def send_json(self, value: dict, status: int = 200) -> None:
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_html(self, html: str) -> None:
        body = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


PAGE = """<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Python AI 实例</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: #f8fafc;
      color: #172033;
      font-family: Inter, "Microsoft YaHei", system-ui, sans-serif;
    }
    main {
      width: min(940px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 28px 0;
    }
    header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 16px;
    }
    h1 {
      margin: 0;
      font-size: 24px;
      line-height: 1.2;
      font-weight: 650;
      letter-spacing: 0;
    }
    .subtitle {
      margin: 6px 0 0;
      color: #64748b;
      font-size: 13px;
      line-height: 1.6;
    }
    .model {
      display: inline-grid;
      grid-template-columns: repeat(2, minmax(70px, 1fr));
      gap: 4px;
      padding: 4px;
      border: 1px solid #d7dde7;
      border-radius: 10px;
      background: white;
    }
    .model button, .primary, .secondary {
      font: inherit;
      cursor: pointer;
    }
    .model button {
      min-height: 32px;
      border: 0;
      border-radius: 7px;
      background: transparent;
      color: #64748b;
      font-size: 13px;
    }
    .model button.active {
      background: #2563eb;
      color: white;
    }
    .grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 14px;
    }
    section {
      min-width: 0;
      border: 1px solid #d7dde7;
      border-radius: 12px;
      background: white;
      box-shadow: 0 8px 24px rgba(15, 23, 42, 0.06);
      padding: 14px;
    }
    h2 {
      margin: 0 0 10px;
      font-size: 15px;
      line-height: 1.3;
      font-weight: 650;
      letter-spacing: 0;
    }
    label {
      display: block;
      margin-bottom: 8px;
      color: #64748b;
      font-size: 12px;
      font-weight: 600;
    }
    textarea {
      width: 100%;
      min-height: 116px;
      resize: vertical;
      border: 1px solid #d7dde7;
      border-radius: 10px;
      padding: 10px 12px;
      color: inherit;
      background: white;
      font: inherit;
      font-size: 14px;
      line-height: 1.5;
      outline: none;
    }
    textarea:focus {
      border-color: #2563eb;
      box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.16);
    }
    .actions {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 10px;
    }
    .primary {
      min-height: 36px;
      border: 0;
      border-radius: 9px;
      background: #2563eb;
      color: white;
      font-size: 14px;
      font-weight: 600;
      padding: 0 14px;
    }
    .secondary {
      min-height: 36px;
      border: 1px solid #d7dde7;
      border-radius: 9px;
      background: white;
      color: #172033;
      font-size: 14px;
      padding: 0 12px;
    }
    button:disabled { cursor: default; opacity: .58; }
    .output, .image {
      min-height: 136px;
      margin-top: 12px;
      border: 1px solid #d7dde7;
      border-radius: 10px;
      background: #f1f5f9;
      overflow: hidden;
    }
    .output {
      padding: 12px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-size: 14px;
      line-height: 1.6;
    }
    .image {
      display: grid;
      place-items: center;
      min-height: 230px;
    }
    .image img {
      width: 100%;
      height: 100%;
      max-height: 420px;
      object-fit: contain;
      display: block;
    }
    .placeholder {
      color: #64748b;
      font-size: 13px;
      text-align: center;
      padding: 18px;
    }
    .status {
      min-height: 20px;
      margin-top: 12px;
      color: #64748b;
      font-size: 13px;
      line-height: 1.5;
    }
    .status.error { color: #dc2626; }
    @media (max-width: 760px) {
      main { width: min(100vw - 24px, 940px); padding: 18px 0; }
      header { flex-direction: column; }
      .model { width: 100%; }
      .grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Python AI 实例</h1>
        <p class="subtitle">Python 独立进程通过平台本地桥调用 AI 能力，页面只保留平台模型档位。</p>
      </div>
      <div class="model" aria-label="模型">
        <button id="fast" class="active" type="button">快速</button>
        <button id="premium" type="button">高级</button>
      </div>
    </header>
    <div class="grid">
      <section>
        <h2>对话</h2>
        <label for="chatPrompt">提示词</label>
        <textarea id="chatPrompt">用三句话说明 Python 插件为什么也可以安全调用平台 AI。</textarea>
        <div class="actions">
          <button id="chatButton" class="primary" type="button">生成回复</button>
          <button id="clearChat" class="secondary" type="button">清空</button>
        </div>
        <div id="chatOutput" class="output">等待生成</div>
      </section>
      <section>
        <h2>生图</h2>
        <label for="imagePrompt">画面描述</label>
        <textarea id="imagePrompt">一个 Python 插件窗口正在生成图片，现代软件工作台界面，干净插画风格</textarea>
        <div class="actions">
          <button id="imageButton" class="primary" type="button">生成图片</button>
          <button id="clearImage" class="secondary" type="button">清空</button>
        </div>
        <div id="imageOutput" class="image"><div class="placeholder">等待生成</div></div>
      </section>
    </div>
    <div id="status" class="status"></div>
  </main>
  <script>
    let model = 'fast';
    let busy = false;
    let timer = null;
    const $ = (id) => document.getElementById(id);
    const modelButtons = [$('fast'), $('premium')];

    function setModel(next) {
      model = next;
      for (const button of modelButtons) {
        button.classList.toggle('active', button.id === next);
      }
    }
    function setBusy(next) {
      busy = next;
      $('chatButton').disabled = next;
      $('imageButton').disabled = next;
      for (const button of modelButtons) button.disabled = next;
    }
    function setStatus(text, error) {
      $('status').textContent = text || '';
      $('status').className = error ? 'status error' : 'status';
    }
    function poll() {
      fetch('/state').then((response) => response.json()).then((state) => {
        setBusy(Boolean(state.busy));
        if (state.error) setStatus(state.error, true);
        if (!state.error && state.busy) setStatus('正在调用平台能力…');
        if (!state.error && !state.busy) setStatus('');
        if (state.chat) $('chatOutput').textContent = state.chat;
        if (state.image) {
          $('imageOutput').innerHTML = '';
          const img = document.createElement('img');
          img.alt = '生成图片';
          img.src = state.image;
          $('imageOutput').appendChild(img);
        }
      }).catch(() => {});
    }
    function ensurePoll() {
      if (!timer) timer = setInterval(poll, 900);
      poll();
    }
    function run(kind) {
      const inputId = kind === 'chat' ? 'chatPrompt' : 'imagePrompt';
      const prompt = $(inputId).value.trim();
      if (!prompt) {
        setStatus(kind === 'chat' ? '请输入提示词。' : '请输入画面描述。', true);
        return;
      }
      setBusy(true);
      setStatus('正在调用平台能力…');
      if (kind === 'chat') $('chatOutput').textContent = '生成中…';
      if (kind === 'image') $('imageOutput').innerHTML = '<div class="placeholder">生成中…</div>';
      fetch('/' + kind + '?model=' + encodeURIComponent(model) + '&prompt=' + encodeURIComponent(prompt), { method: 'POST' })
        .then(() => ensurePoll())
        .catch((error) => setStatus(String(error), true));
    }
    $('fast').addEventListener('click', () => setModel('fast'));
    $('premium').addEventListener('click', () => setModel('premium'));
    $('chatButton').addEventListener('click', () => run('chat'));
    $('imageButton').addEventListener('click', () => run('image'));
    $('clearChat').addEventListener('click', () => { $('chatOutput').textContent = '等待生成'; setStatus(''); });
    $('clearImage').addEventListener('click', () => { $('imageOutput').innerHTML = '<div class="placeholder">等待生成</div>'; setStatus(''); });
    ensurePoll();
  </script>
</body>
</html>"""


def main() -> None:
    server = ThreadingHTTPServer((HOST, 0), DemoHandler)
    port = server.server_address[1]
    url = f"http://{HOST}:{port}"
    print(f"[ai-python-example] {url}", flush=True)
    threading.Timer(0.3, lambda: webbrowser.open(url)).start()
    server.serve_forever()


if __name__ == "__main__":
    main()
