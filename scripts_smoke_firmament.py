#!/usr/bin/env python3
"""Headless smoke test of the Firmament: open, wait for frames, read console + diagnostics, screenshot.
Stdlib + a Playwright-cached Chromium. Usage: python3 scripts_smoke_firmament.py URL [out.png]"""
import base64, glob, json, os, socket, subprocess, sys, time, urllib.request

def ws_connect(url):
    # minimal websocket client (RFC 6455, text frames only)
    from urllib.parse import urlparse
    u = urlparse(url); s = socket.create_connection((u.hostname, u.port), timeout=60)
    key = base64.b64encode(os.urandom(16)).decode()
    s.send(f"GET {u.path} HTTP/1.1\r\nHost: {u.hostname}:{u.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n".encode())
    while b"\r\n\r\n" not in (hdr := s.recv(4096)): pass
    return s

def ws_send(s, obj):
    data = json.dumps(obj).encode(); n = len(data)
    hdr = bytearray([0x81])
    if n < 126: hdr.append(0x80 | n)
    elif n < 65536: hdr += bytes([0x80 | 126]) + n.to_bytes(2, "big")
    else: hdr += bytes([0x80 | 127]) + n.to_bytes(8, "big")
    mask = os.urandom(4); hdr += mask
    s.send(bytes(hdr) + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

def ws_recv(s):
    def rd(n):
        buf = b""
        while len(buf) < n:
            c = s.recv(n - len(buf))
            if not c: raise ConnectionError
            buf += c
        return buf
    b1, b2 = rd(2); n = b2 & 0x7F
    if n == 126: n = int.from_bytes(rd(2), "big")
    elif n == 127: n = int.from_bytes(rd(8), "big")
    return json.loads(rd(n))

def main():
    url = sys.argv[1]; out = sys.argv[2] if len(sys.argv) > 2 else "/tmp/firmament.png"
    chrome = glob.glob(os.path.expanduser("~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome"))[0]
    port = 9333
    proc = subprocess.Popen([chrome, "--headless=new", "--no-sandbox", "--disable-gpu", "--use-gl=angle", "--use-angle=swiftshader",
                             "--enable-unsafe-swiftshader", f"--remote-debugging-port={port}", "--window-size=1400,900", "about:blank"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(50):
            try:
                tabs = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{port}/json").read()); break
            except Exception: time.sleep(0.2)
        s = ws_connect(tabs[0]["webSocketDebuggerUrl"]); mid = [0]
        def call(method, **params):
            mid[0] += 1; ws_send(s, {"id": mid[0], "method": method, "params": params})
            while True:
                m = ws_recv(s)
                if m.get("id") == mid[0]: return m.get("result", m)
                if m.get("method") == "Runtime.consoleAPICalled":
                    args = [a.get("value", a.get("description", "")) for a in m["params"]["args"]]
                    print("console." + m["params"]["type"] + ":", *[str(a)[:300] for a in args])
                if m.get("method") == "Runtime.exceptionThrown":
                    print("EXCEPTION:", m["params"]["exceptionDetails"].get("text"), (m["params"]["exceptionDetails"].get("exception") or {}).get("description", "")[:600])
        call("Runtime.enable"); call("Page.enable")
        call("Page.navigate", url=url)
        deadline = time.time() + 40
        while time.time() < deadline:
            r = call("Runtime.evaluate", expression="document.documentElement.dataset.field", returnByValue=True)
            st = r.get("result", {}).get("value")
            if st in ("running", "failed"): break
            time.sleep(0.5)
        print("state:", st, "after", round(40 - (deadline - time.time()), 1), "s")
        if st == "failed":
            print("error:", call("Runtime.evaluate", expression="document.documentElement.dataset.fieldError", returnByValue=True)["result"].get("value"))
        print("diag:", call("Runtime.evaluate", expression="document.getElementById('diag').textContent", returnByValue=True)["result"].get("value"))
        # fps sample
        call("Runtime.evaluate", expression="window.__f0=performance.now(); window.__n0=(window.__FIELD__&&__FIELD__.frame)||0", returnByValue=True)
        time.sleep(3)
        print("frames/3s:", call("Runtime.evaluate", expression="((window.__FIELD__&&__FIELD__.frame)||0)-window.__n0", returnByValue=True)["result"].get("value"))
        extra = sys.argv[3] if len(sys.argv) > 3 else None
        if extra:
            print("extra:", json.dumps(call("Runtime.evaluate", expression=extra, returnByValue=True, awaitPromise=True)["result"].get("value"))[:3000])
        time.sleep(4)  # let the threshold dissolve
        shot = call("Page.captureScreenshot", format="png")
        open(out, "wb").write(base64.b64decode(shot["data"])); print("screenshot:", out)
    finally:
        proc.terminate()

if __name__ == "__main__":
    main()
