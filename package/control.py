"""Windows user-session service, selective PAC routing, status and rollback."""
import ctypes
import hashlib
import http.server
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import sys
import threading
import time
import urllib.request
import winreg

SOURCE = Path(__file__).resolve().parent
STATE = Path(os.environ['LOCALAPPDATA']) / 'GreyPredictionComposer'
REGISTRY = r'Software\Microsoft\Windows\CurrentVersion\Internet Settings'
RUN_KEY = r'Software\Microsoft\Windows\CurrentVersion\Run'
RUN_NAME = 'GreyPredictionComposer'
PORT = 18891
PAC_PORT = 18892
PAC_URL = f'http://127.0.0.1:{PAC_PORT}/proxy.pac'
HIDDEN = subprocess.CREATE_NO_WINDOW


def require_native_runtime():
    if STATE.resolve() != STATE.absolute():
        raise RuntimeError('Runtime is redirected into a packaged app. Run Install.ps1 from normal Windows PowerShell, outside Codex.')


def native_startup_command():
    # WMI reads Windows' real startup inventory, not our possibly private HKCU view.
    result = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
        "Get-CimInstance Win32_StartupCommand | Where-Object Name -eq 'GreyPredictionComposer' | Select-Object -ExpandProperty Command | ConvertTo-Json -Compress"],
        capture_output=True, text=True, check=True, timeout=15, creationflags=HIDDEN)
    return json.loads(result.stdout) if result.stdout.strip() else None


def write_json(name, value):
    path = STATE / name
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, indent=2), encoding='utf-8')
    temp.replace(path)


def refresh():
    for option in (39, 37):
        ctypes.windll.wininet.InternetSetOptionW(0, option, 0, 0)


def registry_value():
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, REGISTRY) as key:
        try:
            value, kind = winreg.QueryValueEx(key, 'AutoConfigURL')
            return {'exists': True, 'value': value, 'type': kind}
        except FileNotFoundError:
            return {'exists': False}


def restore():
    if registry_value().get('value') != PAC_URL:
        return
    saved = json.loads((STATE / 'pac-before.json').read_text())
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, REGISTRY, 0, winreg.KEY_SET_VALUE) as key:
        if saved['exists']:
            winreg.SetValueEx(key, 'AutoConfigURL', 0, saved['type'], saved['value'])
        else:
            winreg.DeleteValue(key, 'AutoConfigURL')
    refresh()


def apply_routing():
    current = registry_value()
    if current.get('value') != PAC_URL:
        if current.get('value'):
            raise RuntimeError('Another PAC configuration is active; not overwriting it')
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, REGISTRY) as key:
            try:
                if winreg.QueryValueEx(key, 'ProxyEnable')[0]:
                    raise RuntimeError('Another manual proxy is active; not overwriting it')
            except FileNotFoundError:
                pass
        write_json('pac-before.json', current)
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, REGISTRY, 0, winreg.KEY_SET_VALUE) as key:
            winreg.SetValueEx(key, 'AutoConfigURL', 0, winreg.REG_SZ, PAC_URL)
    refresh()


def listening(port):
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=1):
            return True
    except OSError:
        return False


def fetch_config(proxy=False):
    tokens = json.loads((Path.home() / '.codex/auth.json').read_text())['tokens']
    context = ssl.create_default_context()
    if proxy:
        context.load_verify_locations(str(STATE / 'ca/mitmproxy-ca-cert.pem'))
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({'https': f'http://127.0.0.1:{PORT}'} if proxy else {}),
        urllib.request.HTTPSHandler(context=context))
    request = urllib.request.Request('https://chatgpt.com/backend-api/wham/predictions/config', headers={
        'Authorization': 'Bearer ' + tokens['access_token'],
        'ChatGPT-Account-ID': tokens['account_id'],
        'originator': 'codex_desktop', 'x-prompt-predictor-route': 'fork-v1',
        'User-Agent': 'GreyPredictionComposer-Verification/1'})
    with opener.open(request, timeout=30) as response:
        return json.load(response), tokens['account_id']


def prepare():
    STATE.mkdir(parents=True, exist_ok=True)
    require_native_runtime()
    data, account = fetch_config()
    if not isinstance(data.get('prompt'), str) or not isinstance(data.get('is_enabled'), bool):
        raise RuntimeError('Unexpected prediction configuration')
    write_json('stock-config.json', data)
    write_json('settings.json', {
        'account_sha256': hashlib.sha256(account.encode()).hexdigest(),
        'stock_prompt_sha256': hashlib.sha256(data['prompt'].encode()).hexdigest(),
        'stock_prompt_version': data.get('prompt_version')})
    from mitmproxy.certs import CertStore
    CertStore.from_store(str(STATE / 'ca'), 'mitmproxy', 2048)
    print(json.dumps({'prepared': True, 'stock_prompt_version': data.get('prompt_version')}))


def serve():
    STATE.mkdir(parents=True, exist_ok=True)
    # Bind first: only one supervisor can own this installation.
    stop = threading.Event()
    child = None

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            if self.path == '/proxy.pac':
                active = child is not None and child.poll() is None and not (STATE / 'disabled').exists()
                route = f'PROXY 127.0.0.1:{PORT}; DIRECT' if active else 'DIRECT'
                body = ('function FindProxyForURL(url, host) { '
                        'if (host === "chatgpt.com") return "' + route + '"; '
                        'return "DIRECT"; }').encode()
                content_type = 'application/x-ns-proxy-autoconfig'
            elif self.path == '/health':
                body = json.dumps({'service': 'GreyPredictionComposer', 'pid': os.getpid(),
                    'proxy_pid': child.pid if child else None,
                    'proxy_running': child is not None and child.poll() is None,
                    'enabled': not (STATE / 'disabled').exists()}).encode()
                content_type = 'application/json'
            else:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = http.server.ThreadingHTTPServer(('127.0.0.1', PAC_PORT), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        if (STATE / 'disabled').exists():
            restore()
            return
        if listening(PORT):
            raise RuntimeError('Proxy port is occupied by another process')
        log = (STATE / 'proxy-errors.log').open('a', encoding='utf-8')
        child = subprocess.Popen([str(STATE / 'venv/Scripts/mitmdump.exe'), '-q',
            '--listen-host', '127.0.0.1', '--listen-port', str(PORT),
            '--set', f'confdir={STATE / "ca"}', '--set', 'connection_strategy=lazy',
            '--set', 'termlog_verbosity=error', '--allow-hosts', r'^chatgpt\.com:443$',
            '-s', str(SOURCE / 'addon.py')], creationflags=HIDDEN,
            stdin=subprocess.DEVNULL, stdout=log, stderr=log)
        for _ in range(300):
            if child.poll() is not None:
                raise RuntimeError('Proxy failed to start')
            if listening(PORT):
                break
            time.sleep(.1)
        else:
            raise RuntimeError('Proxy listener timed out')
        apply_routing()
        write_json('service-state.json', {'pid': os.getpid(), 'proxy_pid': child.pid, 'started': time.time()})
        while not (STATE / 'disabled').exists() and child.poll() is None:
            time.sleep(1)
    finally:
        restore()
        if child is not None and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
        server.shutdown()
        server.server_close()


def enable():
    require_native_runtime()
    (STATE / 'disabled').unlink(missing_ok=True)
    executable = STATE / 'venv/Scripts/pythonw.exe'
    command = subprocess.list2cmdline([str(executable), str(SOURCE / 'control.py'), 'serve'])
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
        winreg.SetValueEx(key, RUN_NAME, 0, winreg.REG_SZ, command)
    if native_startup_command() != command:
        raise RuntimeError('Windows cannot see the startup entry. Run Enable.cmd from normal Windows, outside Codex.')
    if not listening(PAC_PORT):
        subprocess.Popen([str(executable), str(SOURCE / 'control.py'), 'serve'],
                         creationflags=HIDDEN, stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(350):
        if registry_value().get('value') == PAC_URL and listening(PORT):
            print('Enabled; automatic startup registered.')
            return
        time.sleep(.1)
    raise RuntimeError('Service did not become ready; inspect service-error.json')


def disable():
    (STATE / 'disabled').touch()
    restore()
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
        try:
            winreg.DeleteValue(key, RUN_NAME)
        except FileNotFoundError:
            pass
    for _ in range(70):
        if not listening(PAC_PORT):
            break
        time.sleep(.1)
    print('Disabled; prior PAC setting restored; automatic startup removed.')


def status():
    result = {'routing_active': registry_value().get('value') == PAC_URL,
              'proxy_listening': listening(PORT), 'pac_listening': listening(PAC_PORT),
              'runtime_path': str(STATE.resolve()),
              'runtime_redirected': STATE.resolve() != STATE.absolute(),
              'native_startup_command': native_startup_command()}
    if result['pac_listening']:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(f'http://127.0.0.1:{PAC_PORT}/health', timeout=3) as response:
            result['service'] = json.load(response)
    evidence = STATE / 'evidence.jsonl'
    if evidence.exists():
        events = [json.loads(line) for line in evidence.read_text().splitlines() if line]
        result['recent_config_events'] = [e for e in events if e['event'].startswith('config_')][-6:]
    print(json.dumps(result, indent=2))


def verify():
    stock, _ = fetch_config()
    actual, _ = fetch_config(proxy=True)
    prompt = (SOURCE / 'prompt.txt').read_text(encoding='utf-8').strip()
    changes = [key for key in stock.keys() | actual.keys() if stock.get(key) != actual.get(key)]
    expected = {**stock, 'prompt': prompt, 'live_sample_rate': 1.0, 'catch_up_sample_rate': 1.0, '_prompt_predictor_route': 'fork-v1'}
    if actual != expected:
        raise RuntimeError('Live replacement did not match the approved prompt and rates exactly')
    result = {'verified': True, 'changed_fields': changes,
              'prompt_sha256': hashlib.sha256(prompt.encode()).hexdigest(),
              'live_sample_rate': actual['live_sample_rate'],
              'catch_up_sample_rate': actual['catch_up_sample_rate'], 'time': time.time()}
    write_json('verification.json', result)
    print(json.dumps(result))


if __name__ == '__main__':
    actions = {'prepare': prepare, 'serve': serve, 'enable': enable,
               'disable': disable, 'status': status, 'verify': verify}
    try:
        actions[sys.argv[1]]()
    except Exception as exc:
        STATE.mkdir(parents=True, exist_ok=True)
        write_json('service-error.json', {'time': time.time(), 'error': str(exc), 'kind': type(exc).__name__})
        if sys.stdout:
            print(type(exc).__name__ + ': ' + str(exc))
        raise
