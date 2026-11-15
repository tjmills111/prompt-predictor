"""Run the existing background check without allocating a Windows console.

Wait for completion and preserve its exit code for Task Scheduler.
"""
import pathlib
import subprocess
import sys

script = pathlib.Path(__file__).with_suffix(".ps1")
try:
    result = subprocess.run(
        [r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
         "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
         "-File", str(script), *sys.argv[1:]],
        creationflags=subprocess.CREATE_NO_WINDOW,
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    sys.exit(result.returncode)
except OSError:
    sys.exit(1)
