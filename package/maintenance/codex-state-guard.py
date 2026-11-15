"""Keep durable Codex settings snapshots; recover unreadable settings before launch.

No app/database patches. The watcher only reads Codex state. Recovery is restricted
to the preflight command while ChatGPT.exe is absent, and never rolls back valid
JSON (including intentional project removals). Uses Python's standard library.
"""
import argparse
import contextlib
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import time
import uuid
import zlib


STRUCTURAL_KEYS = (
    'local-projects', 'remote-projects', 'project-order', 'selected-project',
    'pinned-thread-ids', 'pinned-project-ids', 'thread-project-assignments',
    'projectless-thread-ids', 'thread-workspace-root-hints',
    'thread-project-membership-host-ids', 'sidebar-project-thread-orders',
    'app-server-project-id-by-legacy-project-id-by-host',
)


def decode(raw):
    value = json.loads(raw.decode('utf-8-sig'))
    if not isinstance(value, dict):
        raise ValueError('Settings must be a JSON object')
    if 'local-projects' in value and not isinstance(value['local-projects'], dict):
        raise ValueError('Invalid local-projects registry')
    return value


def read(path):
    try:
        raw = path.read_bytes()
        return raw, decode(raw), None
    except (OSError, ValueError, UnicodeError) as error:
        return None, None, str(error)


def app_running():
    if os.name != 'nt':
        raise RuntimeError('Live process detection requires Windows')
    class Entry(ctypes.Structure):
        _fields_ = [('size', wintypes.DWORD), ('usage', wintypes.DWORD),
                    ('pid', wintypes.DWORD), ('heap', ctypes.c_size_t),
                    ('module', wintypes.DWORD), ('threads', wintypes.DWORD),
                    ('parent', wintypes.DWORD), ('priority', wintypes.LONG),
                    ('flags', wintypes.DWORD), ('exe', wintypes.WCHAR * 260)]
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(Entry)]
    kernel.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(Entry)]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.CreateToolhelp32Snapshot(2, 0)
    if handle == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        entry = Entry(size=ctypes.sizeof(Entry))
        if not kernel.Process32FirstW(handle, ctypes.byref(entry)):
            raise ctypes.WinError(ctypes.get_last_error())
        while True:
            if entry.exe.lower() == 'chatgpt.exe':
                return True
            if not kernel.Process32NextW(handle, ctypes.byref(entry)):
                if ctypes.get_last_error() != 18:  # ERROR_NO_MORE_FILES
                    raise ctypes.WinError(ctypes.get_last_error())
                return False
    finally:
        kernel.CloseHandle(handle)


@contextlib.contextmanager
def exclusive(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a+b') as handle:
        handle.seek(0)
        if os.name == 'nt':
            import msvcrt
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == 'nt':
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)


def durable_write(path, raw):
    temporary = path.with_name(path.name + '.guard-' + uuid.uuid4().hex)
    try:
        with temporary.open('xb') as handle:
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


class Guard:
    def __init__(self, state, runtime):
        self.state, self.runtime = Path(state), Path(runtime)
        self.runtime.mkdir(parents=True, exist_ok=True)
        self.database = self.runtime / 'history.sqlite3'
        self.status_file = self.runtime / 'status.json'

    def connect(self):
        connection = sqlite3.connect(self.database, timeout=15)
        connection.execute('pragma synchronous=FULL')
        connection.execute('create table if not exists snapshots '
                           '(id integer primary key, saved real not null, '
                           'sha text not null, structure text not null, body blob not null)')
        connection.execute('create table if not exists incidents '
                           '(id integer primary key, saved real not null, detail text not null)')
        return connection

    def snapshot(self, force=False):
        raw, value, error = read(self.state)
        if error:
            return {'state': 'unreadable', 'error': error}
        digest = hashlib.sha256(raw).hexdigest()
        structure = hashlib.sha256(json.dumps(
            {k: value.get(k) for k in STRUCTURAL_KEYS}, sort_keys=True,
            separators=(',', ':')).encode()).hexdigest()
        with contextlib.closing(self.connect()) as connection, connection:
            latest = connection.execute('select saved,sha,structure from snapshots '
                                        'order by id desc limit 1').fetchone()
            if latest and latest[1] == digest:
                return {'state': 'unchanged', 'sha256': digest}
            if not force and latest and latest[2] == structure and time.time() - latest[0] < 300:
                return {'state': 'unchanged_structure', 'sha256': digest}
            connection.execute('insert into snapshots(saved,sha,structure,body) values(?,?,?,?)',
                               (time.time(), digest, structure, zlib.compress(raw)))
        return {'state': 'snapshotted', 'sha256': digest,
                'projects': len(value.get('local-projects', {}))}

    def preflight(self, is_running=app_running):
        with exclusive(self.runtime / 'preflight.lock'):
            if is_running():
                raise RuntimeError('Codex is running; recovery refused')
            raw, _, error = read(self.state)
            if not error:
                return self.snapshot(force=True)
            # Prefer the app backup, then independent snapshots newest first.
            candidate, _, _ = read(Path(str(self.state) + '.bak'))
            source = 'app_backup'
            if candidate is None:
                with contextlib.closing(self.connect()) as connection:
                    for sha, body in connection.execute('select sha,body from snapshots order by id desc'):
                        try:
                            restored = zlib.decompress(body)
                            decode(restored)
                            if hashlib.sha256(restored).hexdigest() == sha:
                                candidate, source = restored, 'independent_snapshot'
                                break
                        except (ValueError, UnicodeError, zlib.error):
                            continue
            if candidate is None:
                # A truly new installation has no file or history to recover.
                if not self.state.exists() and not Path(str(self.state) + '.bak').exists():
                    return {'state': 'new_installation'}
                raise RuntimeError('Unreadable Codex settings and no verified recovery copy')
            stamp = str(time.time_ns())
            before = {}
            for target in (self.state, Path(str(self.state) + '.bak')):
                before[target] = target.read_bytes() if target.exists() else None
                if before[target] is not None:
                    durable_write(self.runtime / (stamp + '-' + target.name + '.before'), before[target])
            # Refuse a concurrent launch/change before either replacement.
            for target in (Path(str(self.state) + '.bak'), self.state):
                actual = target.read_bytes() if target.exists() else None
                if is_running() or actual != before[target]:
                    raise RuntimeError('Concurrent app launch/settings change; recovery stopped')
                durable_write(target, candidate)
            if self.state.read_bytes() != candidate:
                raise RuntimeError('Recovery readback failed')
            result = {'state': 'recovered', 'source': source, 'cause': error,
                      'sha256': hashlib.sha256(candidate).hexdigest(), 'preservedPrefix': stamp}
            with contextlib.closing(self.connect()) as connection, connection:
                connection.execute('insert into incidents(saved,detail) values(?,?)',
                                   (time.time(), json.dumps(result)))
            self.snapshot(force=True)
            return result

    def status(self):
        status = json.loads(self.status_file.read_text()) if self.status_file.exists() else {}
        with contextlib.closing(self.connect()) as connection:
            status['snapshots'] = connection.execute('select count(*) from snapshots').fetchone()[0]
            status['recoveries'] = connection.execute('select count(*) from incidents').fetchone()[0]
        return status

    def watch(self):
        try:
            with exclusive(self.runtime / 'watch.lock'):
                (self.runtime / 'stop').unlink(missing_ok=True)
                while not (self.runtime / 'stop').exists():
                    try:
                        result = self.snapshot()
                    except Exception as error:
                        result = {'state': 'error', 'error': str(error)}
                    durable_write(self.status_file, json.dumps(
                        {'pid': os.getpid(), 'at': time.time(), **result}).encode())
                    time.sleep(2)
        except OSError:
            # Another guard already owns the OS-released lifetime lock.
            return


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['snapshot', 'preflight', 'watch', 'ensure-watch', 'status', 'stop'])
    parser.add_argument('--state', type=Path, default=Path(os.environ.get('CODEX_HOME', Path.home() / '.codex')) / '.codex-global-state.json')
    parser.add_argument('--runtime', type=Path, default=Path(os.environ.get('LOCALAPPDATA', Path.home() / 'AppData/Local')) / 'CodexStateRecovery')
    args = parser.parse_args()
    guard = Guard(args.state, args.runtime)
    if args.action == 'watch':
        guard.watch()
        return
    if args.action == 'ensure-watch':
        try:
            with exclusive(guard.runtime / 'watch.lock'):
                subprocess.Popen([sys.executable, '-B', str(Path(__file__).resolve()), 'watch',
                                  '--state', str(args.state), '--runtime', str(args.runtime)],
                                 creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except OSError:
            pass
        result = {'state': 'watch_requested'}
    elif args.action == 'stop':
        durable_write(guard.runtime / 'stop', b'stop')
        result = {'state': 'stop_requested'}
    else:
        result = getattr(guard, args.action)()
    print(json.dumps(result))


if __name__ == '__main__':
    main()
