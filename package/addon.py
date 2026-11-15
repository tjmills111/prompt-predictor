"""Override the known prediction prompt and generation rates for the installed account."""
import hashlib
import json
import os
import time
from pathlib import Path

SOURCE = Path(__file__).resolve().parent
STATE = Path(os.environ['LOCALAPPDATA']) / 'GreyPredictionComposer'
CONFIG_PATH = '/backend-api/wham/predictions/config'


def digest(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def log(event, **fields):
    path = STATE / 'evidence.jsonl'
    if path.exists() and path.stat().st_size > 2_000_000:
        path.replace(STATE / 'evidence.previous.jsonl')
    with path.open('a', encoding='utf-8') as out:
        out.write(json.dumps({'time': time.time(), 'event': event, **fields}) + '\n')


def requestheaders(flow):
    req = flow.request
    target = (req.host == 'chatgpt.com' and req.method == 'GET'
              and req.path.split('?')[0] == CONFIG_PATH)
    flow.metadata['prediction_config'] = target
    flow.metadata['owned_route'] = req.headers.get('x-prompt-predictor-route', '') == 'fork-v1'
    if not target:
        req.stream = True
        return
    try:
        config = json.loads((STATE / 'settings.json').read_text())
        match = digest(req.headers.get('chatgpt-account-id', '')) == config['account_sha256']
        flow.metadata['account_match'] = match
        log('config_request', account_match=match, peer=flow.client_conn.peername,
            user_agent=req.headers.get('user-agent', ''))
    except Exception as exc:
        log('settings_error', kind=type(exc).__name__)


def responseheaders(flow):
    if not flow.metadata.get('prediction_config'):
        flow.response.stream = True


def response(flow):
    if not flow.metadata.get('prediction_config'):
        return
    try:
        original_text = flow.response.get_text()
        data = json.loads(original_text)
        settings = json.loads((STATE / 'settings.json').read_text())
        valid = (flow.response.status_code == 200
                 and flow.metadata.get('account_match')
                 and isinstance(data, dict)
                 and isinstance(data.get('prompt'), str)
                 and isinstance(data.get('is_enabled'), bool)
                 and digest(data['prompt']) == settings['stock_prompt_sha256'])
        modified = False
        changed_fields = []
        if valid and not (STATE / 'disabled').exists():
            prompt = (SOURCE / 'prompt.txt').read_text(encoding='utf-8').strip()
            if not prompt or len(prompt) > 20000:
                raise ValueError('Invalid prompt file')
            if flow.metadata.get('owned_route'):
                data['prompt'] = prompt
                data['_prompt_predictor_route'] = 'fork-v1'
            data['live_sample_rate'] = 1.0
            data['catch_up_sample_rate'] = 1.0
            original = json.loads(original_text)
            changed_fields = sorted(key for key in data if data[key] != original.get(key))
            flow.response.text = json.dumps(data, ensure_ascii=False)
            for header in ('etag', 'content-md5', 'digest'):
                flow.response.headers.pop(header, None)
            flow.response.headers['cache-control'] = 'no-store'
            vary = flow.response.headers.get('vary', '')
            flow.response.headers['vary'] = (vary + ', ' if vary else '') + 'x-prompt-predictor-route'
            modified = True
        log('config_response', status=flow.response.status_code, modified=modified,
            changed_fields=changed_fields, owned_route=flow.metadata.get('owned_route', False),
            live_sample_rate=data.get('live_sample_rate') if isinstance(data, dict) else None,
            catch_up_sample_rate=data.get('catch_up_sample_rate') if isinstance(data, dict) else None,
            prompt_version=data.get('prompt_version') if isinstance(data, dict) else None,
            prompt_sha256=digest(data['prompt']) if isinstance(data, dict) and isinstance(data.get('prompt'), str) else None)
    except Exception as exc:
        log('response_error', kind=type(exc).__name__)


def tls_failed_client(data):
    if data.conn.sni == 'chatgpt.com':
        log('client_tls_failed', peer=data.conn.peername)


def error(flow):
    if flow.metadata.get('prediction_config'):
        log('config_error', kind='transport_error')
