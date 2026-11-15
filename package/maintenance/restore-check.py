"""Read-only account/baseline check before restoring an unchanged removed installation."""
import hashlib
import json
from pathlib import Path
import sys


def validate(control):
    settings = json.loads((control.STATE / 'settings.json').read_text(encoding='utf-8'))
    config, account = control.fetch_config()
    digest = lambda value: hashlib.sha256(value.encode('utf-8')).hexdigest()
    if digest(account) != settings['account_sha256']:
        raise RuntimeError('Signed-in account changed; Restore does not rebind accounts')
    if not isinstance(config.get('prompt'), str) or digest(config['prompt']) != settings['stock_prompt_sha256']:
        raise RuntimeError('Upstream baseline changed; Restore will not refresh it automatically')
    if config.get('is_enabled') is not True:
        raise RuntimeError('Account is no longer eligible for predictions')
    return {'sameAccount': True, 'sameBaseline': True, 'eligible': True, 'changesMade': False}


if __name__ == '__main__':
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    import control
    control.require_native_runtime()
    print(json.dumps(validate(control)))
