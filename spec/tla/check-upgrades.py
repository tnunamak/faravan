#!/usr/bin/env python3
"""Check every config of the two upgrade models, including expected failures."""
import argparse
import hashlib
from pathlib import Path
import re
import subprocess
import tempfile
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--jar', type=Path, default=Path.home() / '.tmp/tla/tla2tools.jar')
parser.add_argument('--sha256', default='011267fca25d0752cf18894dd585cd28b96960c112ea8a20b823ea770e7e10cd')
args = parser.parse_args()
if hashlib.sha256(args.jar.read_bytes()).hexdigest() != args.sha256:
    parser.error('jar checksum differs; see UPGRADE.md before selecting another jar')
spec = Path(__file__).resolve().parent
scratch = Path.home() / '.tmp'
scratch.mkdir(exist_ok=True)
failed = False
print('Config | Expected | Actual | Generated | Distinct | Seconds', flush=True)
for model in ('AdmissionRecovery', 'LaunchComposition'):
    for config in sorted(spec.glob(model + '*.cfg')):
        expected = re.search(r'Expected: (\S+)', config.read_text())[1]
        started = time.monotonic()
        with tempfile.TemporaryDirectory(prefix='upgrade-tlc-', dir=scratch) as meta:
            command = ['nice', '-n', '19', 'java', '-XX:+UseParallelGC', '-Xmx1200m',
                       '-XX:MaxDirectMemorySize=400m', '-cp', str(args.jar.resolve()),
                       'tlc2.TLC', '-workers', '2', '-cleanup', '-noGenerateSpecTE',
                       '-metadir', meta, '-config', config.name, model + '.tla']
            try:
                run = subprocess.run(command, cwd=spec, capture_output=True, text=True, timeout=300)
                output = run.stdout + run.stderr
                violation = re.search(r'(?:Invariant|Action property) (\w+) is violated|Temporal property (\w+) was violated', output)
                actual = next(g for g in violation.groups() if g) if violation else (
                    'pass' if 'Model checking completed. No error has been found.' in output else 'error')
            except subprocess.TimeoutExpired as error:
                actual, output = 'timeout', str(error)
        counts = re.findall(r'([\d,]+) states generated, ([\d,]+) distinct states found', output)
        generated, distinct = counts[-1] if counts else ('?', '?')
        print(f'{config.stem} | {expected} | {actual} | {generated} | {distinct} | {time.monotonic()-started:.2f}', flush=True)
        if actual != expected:
            failed = True
            print(output, flush=True)
raise SystemExit(1 if failed else 0)
