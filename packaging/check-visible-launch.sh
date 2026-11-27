#!/usr/bin/env bash
# Read-only evidence collector. No application CLI, launcher or mutation commands.
set -eu
if ! command -v python3 >/dev/null 2>&1; then
  printf '%s\n' '{"checks":[{"name":"runtime","status":"UNKNOWN","command":"command -v python3","detail":"Python 3 required; no checks ran"}],"accepted":false}'
  exit 1
fi
exec python3 - "$@" <<'PY'
import argparse, json, math, os, re, shlex, subprocess, sys, time
from urllib.parse import urlsplit
p = argparse.ArgumentParser(description='Read-only semantic/window visibility evidence; never certifies compositor pixels.')
p.add_argument('--home', required=True, help='Absolute Faravan state home (FARAVAN_HOME/FARAVAN_HOME), not OS HOME')
p.add_argument('--json', action='store_true')
p.add_argument('--url', help='Known local HTTP origin, e.g. http://127.0.0.1:43123; no token')
a = p.parse_args()
if not os.path.isabs(a.home):
    p.error('--home must be absolute')
home = os.path.realpath(a.home)
rows = []
def add(name, status, command, detail):
    rows.append(dict(name=name, status=status, command=command, detail=detail))
def run(argv, report_argv=None):
    # Executed arguments may contain private metadata. Callers provide a separate
    # safe description before either success or exception results can be reported.
    command = shlex.join(argv if report_argv is None else report_argv)
    try:
        r = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=5)
        # Never include arbitrary stderr/stdout in a report (may contain private values).
        return r.returncode, r.stdout, command
    except (OSError, subprocess.TimeoutExpired):
        return None, '', command

def env_for(pid):
    # Read process metadata only, never app.json, token files or credential stores.
    # Keep only the explicit identity/session allow-list, never print raw environment.
    keys = {'FARAVAN_HOME', 'FARAVAN_HOME', 'DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS'}
    try:
        raw = open('/proc/' + str(pid) + '/environ', 'rb').read(1048576)
        return {k:v for item in raw.decode(errors='replace').split('\0') if '=' in item
                for k,v in [item.split('=', 1)] if k in keys}
    except OSError:
        return None

def bus(argv, address=None):
    # Do not activate a watcher, accessibility bus/registry, or other service.
    # Use explicit Properties.Get calls: busctl documents --auto-start for call,
    # not get-property. This also makes interactive authorization opt-out exact.
    property_read = argv[0] == 'get-property'
    if property_read:
        _, service, path, interface, prop = argv
        argv = ['call', service, path, 'org.freedesktop.DBus.Properties', 'Get', 'ss', interface, prop]
    options = ['--auto-start=no', '--allow-interactive-authorization=no', '--timeout=3', '--json=short']
    # Bus addresses and discovered service/object identifiers are not report data.
    # Keep fixed interface/method/property names, never their dynamic targets.
    report_args = [argv[0], '<bus-service>', '<object-path>'] + argv[3:]
    if argv[3:5] == ['org.freedesktop.DBus', 'GetConnectionUnixProcessID']:
        report_args[-1] = '<bus-owner>'
    code, out, cmd = run(['busctl', '--address=' + address if address else '--user'] + options + argv,
                        ['busctl', '--address=<omitted>' if address else '--user'] + options + report_args)
    try:
        value = json.loads(out)['data'] if code == 0 else None
        if property_read:
            value = [value[0]['data']] if isinstance(value, list) and len(value) == 1 and isinstance(value[0], dict) and 'data' in value[0] else None
    except (ValueError, KeyError, TypeError):
        value = None
    return value, cmd

def scalar(value, kind):
    return value[0] if isinstance(value, list) and len(value) == 1 and type(value[0]) is kind else None

def array(value):
    return value[0] if isinstance(value, list) and len(value) == 1 and isinstance(value[0], list) else value

def owner_pid(service, address=None):
    return bus(['call', 'org.freedesktop.DBus', '/org/freedesktop/DBus',
                'org.freedesktop.DBus', 'GetConnectionUnixProcessID', 's', service], address)

def atspi_evidence(pid, title):
    commands = ['inspect caller ATSPI_BUS_ADDRESS (value omitted)']
    def query(args, address=None):
        value, command = bus(args, address)
        commands.append(command)
        return value
    # GetAddress can launch the a11y daemon even with D-Bus auto-start disabled.
    # Only use an address already known to the caller; never discover via launcher.
    address = os.environ.get('ATSPI_BUS_ADDRESS', '')
    if not address.startswith('unix:') or ';' in address or '\n' in address or '\r' in address:
        return 'UNKNOWN', '; '.join(commands), 'No single local ATSPI_BUS_ADDRESS already available; never call the bus launcher'
    alive = query(['call', 'org.freedesktop.DBus', '/org/freedesktop/DBus',
                   'org.freedesktop.DBus', 'NameHasOwner', 's', 'org.a11y.atspi.Registry'], address)
    if scalar(alive, bool) is not True:
        return 'UNKNOWN', '; '.join(commands), 'No already-running accessibility registry; never activated'
    # Only enumerate roots for the target process and same-user, known panels.
    rc, out, cmd = run(['ps', '-axo', 'pid=,uid=,comm='])
    commands.append(cmd)
    panels = set()
    if rc == 0:
        for line in out.splitlines():
            fields = line.strip().split(None, 2)
            if len(fields) == 3 and fields[0].isdigit() and fields[1] == str(os.getuid()) and os.path.basename(fields[2]) in ('gnome-shell', 'plasmashell', 'xfce4-panel', 'mate-panel', 'cinnamon'):
                panels.add(int(fields[0]))
    iface = 'org.a11y.atspi.Accessible'
    roots = array(query(['call', 'org.a11y.atspi.Registry', '/org/a11y/atspi/accessible/root', iface, 'GetChildren'], address))
    if not isinstance(roots, list):
        return 'UNKNOWN', '; '.join(commands), 'Accessibility registry unavailable; never activated'
    queue, seen, candidates = [], set(), []
    incomplete = rc != 0  # Unknown panel inventory cannot exclude other roots.
    deadline = time.monotonic() + 5
    for root in roots[:128]:
        if time.monotonic() >= deadline:
            incomplete = True
            break
        if not isinstance(root, list) or len(root) != 2 or not all(isinstance(x, str) for x in root):
            incomplete = True
            continue
        value, cmd = owner_pid(root[0], address)
        commands.append(cmd)
        owner = scalar(value, int)
        if owner is None or owner <= 0:
            # An unresolved root may belong to the target; it cannot be excluded.
            incomplete = True
            continue
        if owner == pid or owner in panels:
            queue.append((root[0], root[1], owner, False))
    if len(roots) > 128:
        incomplete = True
    while queue and len(seen) < 128 and time.monotonic() < deadline:
        service, path, owner, in_panel = queue.pop(0)
        if (service, path) in seen:
            continue
        seen.add((service, path))
        role = scalar(query(['call', service, path, iface, 'GetRoleName'], address), str)
        in_panel = in_panel or role in ('panel', 'status bar')
        name = scalar(query(['get-property', service, path, iface, 'Name'], address), str)
        if not role or name is None:
            # Missing classification/name cannot rule out another matching item.
            incomplete = True
        if in_panel and name == title:
            state = array(query(['call', service, path, iface, 'GetState'], address))
            rect = array(query(['call', service, path, 'org.a11y.atspi.Component', 'GetExtents', 'u', '0'], address))
            states_ok = isinstance(state, list) and len(state) == 2 and all(type(x) is int for x in state)
            rect_ok = isinstance(rect, list) and len(rect) == 4 and all(type(x) is int for x in rect)
            showing = states_ok and bool(state[0] & (1 << 25)) and bool(state[0] & (1 << 30)) and not bool(state[0] & ((1 << 6) | (1 << 27)))
            usable = rect_ok and rect[2] > 0 and rect[3] > 0 and rect[0] != -2147483648 and rect[1] != -2147483648
            candidates.append((owner == pid, states_ok and rect_ok, showing and usable))
        children = array(query(['call', service, path, iface, 'GetChildren'], address))
        if not isinstance(children, list):
            incomplete = True
            continue
        for child in children[:128]:
            # Do not transfer identity across an application's bus boundary.
            if isinstance(child, list) and len(child) == 2 and child[0] == service and isinstance(child[1], str):
                queue.append((child[0], child[1], owner, in_panel))
            else:
                incomplete = True
        if len(children) > 128:
            incomplete = True
    incomplete = incomplete or bool(queue)
    if not incomplete and len(candidates) == 1 and candidates[0][0] and candidates[0][1]:
        return ('PASS' if candidates[0][2] else 'FAIL'), '; '.join(commands), 'Unique title-matched panel item exported by target tray PID; VISIBLE/SHOWING and positive screen extents ' + ('present (semantic evidence, not pixels)' if candidates[0][2] else 'absent')
    return 'UNKNOWN', '; '.join(commands), 'No unique complete PID-bound panel item; title-only shell proxies, inaccessible/truncated trees and missing bindings are not proof'

# Pure metadata API; no AppKit activation, AppleScript, AX API, screen image,
# CGRequestScreenCaptureAccess, toolchain invocation or permission request.
MAC_WINDOW_PROBE = r'''
# FARAVAN_CG_WINDOW_METADATA_V1
import ctypes as C, json, os, plistlib, sys
result = {'gui': False, 'windows': None, 'status_level': None}
try:
    cf = C.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
    cg = C.CDLL('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
    def bind(lib, name, result_type, args):
        f = getattr(lib, name); f.restype = result_type; f.argtypes = args; return f
    ptr, index = C.c_void_p, C.c_long
    release = bind(cf, 'CFRelease', None, [ptr])
    string = bind(cf, 'CFStringCreateWithCString', ptr, [ptr, C.c_char_p, C.c_uint32])
    get = bind(cf, 'CFDictionaryGetValue', ptr, [ptr, ptr])
    data = bind(cf, 'CFPropertyListCreateData', ptr, [ptr, ptr, index, index, ptr])
    length = bind(cf, 'CFDataGetLength', index, [ptr])
    bytes_at = bind(cf, 'CFDataGetBytePtr', ptr, [ptr])
    count = bind(cf, 'CFArrayGetCount', index, [ptr])
    at = bind(cf, 'CFArrayGetValueAtIndex', ptr, [ptr, index])
    session_copy = bind(cg, 'CGSessionCopyCurrentDictionary', ptr, [])
    window_copy = bind(cg, 'CGWindowListCopyWindowInfo', ptr, [C.c_uint32, C.c_uint32])
    level = bind(cg, 'CGWindowLevelForKey', C.c_int32, [C.c_int32])
    def selected(dictionary, key):
        k = string(None, key.encode(), 0x08000100)  # kCFStringEncodingUTF8
        value = get(dictionary, k); release(k)
        if not value: return None
        encoded = data(None, value, 100, 0, None)  # XML property list v1.0
        if not encoded: return None
        try: return plistlib.loads(C.string_at(bytes_at(encoded), length(encoded)))
        finally: release(encoded)
    session = session_copy()
    if session:
        try:
            result['gui'] = selected(session, 'kCGSessionOnConsoleKey') is True and selected(session, 'kCGSessionLoginDoneKey') is True and selected(session, 'kCGSessionUserIDKey') == os.getuid()
        finally: release(session)
    if result['gui']:
        result['status_level'] = level(9)  # kCGStatusWindowLevelKey, SDK enum
        windows = window_copy(1 | 16, 0)  # OnScreenOnly | ExcludeDesktopElements
        if windows:
            try:
                selected_windows = []
                for i in range(count(windows)):
                    window = at(windows, i)
                    owner = selected(window, 'kCGWindowOwnerPID')
                    if type(owner) is not int or owner <= 0: raise ValueError('unclassified window owner')
                    if owner != int(sys.argv[1]): continue
                    # No window names, other apps' metadata or pixel buffers copied.
                    selected_windows.append({key: selected(window, key) for key in ('kCGWindowNumber', 'kCGWindowLayer', 'kCGWindowIsOnscreen', 'kCGWindowAlpha', 'kCGWindowBounds')})
                # Publish only a complete enumeration, never an exception's prefix.
                result['windows'] = selected_windows
            finally: release(windows)
except (OSError, AttributeError, ValueError, TypeError, OverflowError):
    pass
print(json.dumps(result))
'''

def units(role):
    code, out, cmd = run(['systemctl', '--user', '--no-ask-password', '--no-pager', '--plain', '--no-legend',
                          'list-units', '--all', 'faravan-preview-' + role + '-*.service'])
    if code != 0:
        add(role + '_unit', 'UNKNOWN', cmd, 'Cannot enumerate preview user units')
        return None, None
    matches = []
    for line in out.splitlines():
        name = line.split()[0] if line.split() else ''
        if not re.fullmatch('faravan-preview-' + role + r'-[A-Za-z0-9.-]+\.service', name):
            continue
        rc, info, show = run(['systemctl', '--user', '--no-ask-password', '--no-pager', 'show', name,
                             '--property=MainPID', '--property=ActiveState'])
        props = dict(x.split('=', 1) for x in info.splitlines() if '=' in x)
        if rc != 0 or not props.get('MainPID', '').isdigit():
            continue
        pid = int(props['MainPID'])
        env = env_for(pid) if pid else None
        selected = env.get('FARAVAN_HOME') or env.get('FARAVAN_HOME') if env is not None else None
        if selected and os.path.realpath(selected) == home:
            matches.append((pid, env, props.get('ActiveState'), show))
    if len(matches) != 1:
        add(role + '_unit', 'UNKNOWN', cmd + '; read /proc/<candidate MainPID>/environ (selected keys only)',
            'Need exactly one live unit bound to requested state home; found ' + str(len(matches)) +
            '. Inactive/no PID or unreadable metadata cannot establish home identity.')
        return None, None
    pid, env, state, show = matches[0]
    add(role + '_unit', 'PASS' if state == 'active' else 'FAIL', show + '; read /proc/' + str(pid) + '/environ (selected keys only)',
        'Home-bound process PID ' + str(pid) + '; ActiveState=' + str(state))
    return pid, env

rc, platform, platform_cmd = run(['uname', '-s'])
platform = platform.strip() if rc == 0 else ''
drawn_status, drawn_command, drawn_detail = 'UNKNOWN', platform_cmd, 'No supported, identity-bound desktop visibility evidence'
if platform == 'Linux':
    app_pid, app_env = units('app')
    tray_pid, tray_env = units('tray')
    session = os.environ.get('XDG_SESSION_ID', '')
    if session and re.fullmatch(r'[A-Za-z0-9_-]+', session):
        rc, out, cmd = run(['loginctl', '--no-ask-password', '--no-pager', 'show-session', session,
                            '--property=Active', '--property=Type', '--property=User', '--property=Remote'])
        props = dict(x.split('=', 1) for x in out.splitlines() if '=' in x)
        graphical = props.get('Active') == 'yes' and props.get('Type') in ('x11', 'wayland') and props.get('User') == str(os.getuid())
        display_keys = [k for k in ('DISPLAY', 'WAYLAND_DISPLAY') if os.environ.get(k)]
        same = tray_env is not None and bool(display_keys) and all(tray_env.get(k) == os.environ[k] for k in display_keys)
        same_bus = bool(os.environ.get('DBUS_SESSION_BUS_ADDRESS')) and tray_env is not None and tray_env.get('DBUS_SESSION_BUS_ADDRESS') == os.environ['DBUS_SESSION_BUS_ADDRESS']
        add('tray_graphical_session', 'PASS' if rc == 0 and graphical and same and same_bus else 'UNKNOWN', cmd + '; compare selected tray process metadata with caller',
            'Active graphical user session and display/bus metadata match' if rc == 0 and graphical and same and same_bus else 'Graphical-session binding not established; run from the target logged-in desktop terminal')
    else:
        add('tray_graphical_session', 'UNKNOWN', 'inspect caller XDG_SESSION_ID', 'No identifiable graphical login session')
    matched_items = []
    items, cmd = bus(['get-property', 'org.kde.StatusNotifierWatcher', '/StatusNotifierWatcher',
                     'org.kde.StatusNotifierWatcher', 'RegisteredStatusNotifierItems'])
    items = array(items)
    if not isinstance(items, list):
        items = None
    if items is None:
        add('tray_registration', 'UNKNOWN', cmd, 'Watcher unavailable or response unreadable; desktop may lack a StatusNotifier host. This does not prove tray absent.')
    else:
        matched = False
        unknown = False
        commands = [cmd]
        for item in items if isinstance(items, list) else []:
            if not isinstance(item, str):
                unknown = True
                continue
            service = item.split('/', 1)[0]
            if not re.fullmatch(r'[:A-Za-z0-9_.-]+', service):
                unknown = True
                continue
            owner, owner_cmd = owner_pid(service)
            commands.append(owner_cmd)
            if owner is None:
                unknown = True
            elif tray_pid and owner == [tray_pid]:
                matched = True
                path = '/' + item.split('/', 1)[1] if '/' in item else '/StatusNotifierItem'
                if re.fullmatch(r'/(?:[A-Za-z0-9_]+(?:/[A-Za-z0-9_]+)*)?', path):
                    matched_items.append((service, path))
        status = 'PASS' if matched else ('UNKNOWN' if unknown or not tray_pid else 'FAIL')
        add('tray_registration', status, '; '.join(commands), 'Registered item bus owner matches target tray MainPID' if matched else 'No confirmed target-tray registration in watcher snapshot')
    host, host_cmd = bus(['get-property', 'org.kde.StatusNotifierWatcher', '/StatusNotifierWatcher',
                          'org.kde.StatusNotifierWatcher', 'IsStatusNotifierHostRegistered'])
    host = scalar(host, bool)
    add('tray_host', 'UNKNOWN' if host is None else ('PASS' if host else 'FAIL'), host_cmd,
        'Watcher reports a registered visualization host' if host else 'No registered host' if host is False else 'Host property unreadable; do not infer absence')
    if 'GNOME' in os.environ.get('XDG_CURRENT_DESKTOP', '').upper().split(':'):
        states, commands = [], []
        for uuid in ('appindicatorsupport@rgcjonas.gmail.com', 'ubuntu-appindicators@ubuntu.com'):
            info, cmd = bus(['call', 'org.gnome.Shell', '/org/gnome/Shell',
                             'org.gnome.Shell.Extensions', 'GetExtensionInfo', 's', uuid])
            commands.append(cmd)
            info = info[0] if isinstance(info, list) and len(info) == 1 else None
            if isinstance(info, list) and len(info) % 2 == 0 and all(isinstance(info[i], str) for i in range(0, len(info), 2)):
                info = dict(zip(info[::2], info[1::2]))
            info = info if isinstance(info, dict) else None
            state = info.get('state') if info else None
            if isinstance(state, dict):
                state = state.get('data')
            states.append(state if type(state) in (int, float) else None)
        add('gnome_appindicator_extension', 'PASS' if 1 in states else 'FAIL' if all(x is not None for x in states) else 'UNKNOWN',
            '; '.join(commands), 'Enabled AppIndicator support found' if 1 in states else 'Stock GNOME needs enabled AppIndicator support; absent/unreadable extension state does not rule out an independent host')
    title = None
    if len(set(matched_items)) == 1:
        service, path = matched_items[0]
        values, commands = {}, {}
        for prop in ('Status', 'IconName', 'IconPixmap', 'Title'):
            values[prop], commands[prop] = bus(['get-property', service, path, 'org.kde.StatusNotifierItem', prop])
        status = scalar(values['Status'], str)
        title = scalar(values['Title'], str)
        icon_name = scalar(values['IconName'], str)
        pixmaps = array(values['IconPixmap'])
        pixmap_ok = isinstance(pixmaps, list) and any(isinstance(x, list) and len(x) == 3 and type(x[0]) is int and type(x[1]) is int and 0 < x[0] <= 4096 and 0 < x[1] <= 4096 and isinstance(x[2], list) and len(x[2]) == x[0] * x[1] * 4 and all(type(b) is int and 0 <= b <= 255 for b in x[2]) for x in pixmaps)
        add('tray_item_status', 'PASS' if status in ('Active', 'NeedsAttention') else 'FAIL' if status == 'Passive' else 'UNKNOWN', commands['Status'],
            'Item requests visible presentation' if status in ('Active', 'NeedsAttention') else 'Item requests passive presentation' if status == 'Passive' else 'Unsupported or unavailable item Status')
        add('tray_item_icon', 'PASS' if icon_name or pixmap_ok else 'FAIL' if icon_name == '' and pixmaps == [] else 'UNKNOWN',
            commands['IconName'] + '; ' + commands['IconPixmap'], 'Icon name or valid ARGB32 pixmap present; theme resolution/rendering not established' if icon_name or pixmap_ok else 'No usable icon established')
        add('tray_item_title', 'PASS' if title else 'FAIL' if title == '' else 'UNKNOWN', commands['Title'],
            'Nonempty item Title available for exact accessibility matching (value not disclosed)' if title else 'No usable Title for accessibility matching')
    else:
        for prop in ('status', 'icon', 'title'):
            add('tray_item_' + prop, 'UNKNOWN', 'not run (need exactly one PID-bound StatusNotifierItem)', 'Item identity unavailable or ambiguous')
    if tray_pid and title and any(r['name'] == 'tray_graphical_session' and r['status'] == 'PASS' for r in rows):
        status, cmd, detail = atspi_evidence(tray_pid, title)
    else:
        status, cmd, detail = 'UNKNOWN', 'not run (need home/session-bound tray PID and item Title)', 'Accessibility check prerequisites unavailable'
    add('tray_accessibility', status, cmd, detail)
    required = ('tray_unit', 'tray_graphical_session', 'tray_registration', 'tray_host', 'tray_item_status', 'tray_item_icon', 'tray_item_title', 'tray_accessibility')
    evidence = [r for r in rows if r['name'] in required]
    drawn_status = 'FAIL' if any(r['status'] == 'FAIL' for r in evidence) else 'PASS' if len(evidence) == len(required) and all(r['status'] == 'PASS' for r in evidence) else 'UNKNOWN'
    drawn_command = '; '.join(r['command'] for r in evidence)
    drawn_detail = 'Identity-bound desktop semantic criterion only; PASS requires host, own item properties and PID-bound AT-SPI SHOWING/VISIBLE extents. Not compositor-pixel proof.'
elif platform == 'Darwin':
    rc, out, cmd = run(['ps', '-axo', 'pid=,ppid=,uid=,comm='])
    bundle_pids = []
    processes = {}
    if rc == 0:
        for line in out.splitlines():
            fields = line.strip().split(None, 3)
            if len(fields) == 4 and fields[0].isdigit() and fields[1].isdigit() and fields[2] == str(os.getuid()):
                processes[int(fields[0])] = (int(fields[1]), fields[3])
                if fields[3].endswith('/Faravan.app/Contents/MacOS/faravan-launch'):
                    bundle_pids.append(int(fields[0]))
    add('bundle_process', 'PASS' if len(bundle_pids) == 1 else 'UNKNOWN', cmd,
        'One current-user bundle launcher found' if len(bundle_pids) == 1 else 'Need one unambiguous running Faravan bundle launcher')
    add('isolated_home', 'UNKNOWN', 'none (no credential or raw process-environment inspection)',
        'macOS process-to-state-home binding unavailable from permitted non-secret metadata; bundle name alone is insufficient')
    if len(bundle_pids) == 1:
        rc, out, cmd = run(['lsappinfo', 'info', '-only', 'pid', 'pid=' + str(bundle_pids[0])])
        found = re.search(r'"?pid"?\s*[=:]\s*' + str(bundle_pids[0]) + r'\b', out, re.I)
        add('launchservices', 'PASS' if rc == 0 and found else 'UNKNOWN', cmd,
            'Running PID registered with LaunchServices' if rc == 0 and found else 'LaunchServices running identity not established')
    else:
        add('launchservices', 'UNKNOWN', 'lsappinfo info -only pid pid=<verified launcher>', 'No unambiguous launcher PID')
    tray_pids = []
    if len(bundle_pids) == 1:
        launcher = bundle_pids[0]
        expected = processes[launcher][1].rsplit('/', 1)[0] + '/faravan-tray'
        for pid, (parent, executable) in processes.items():
            if executable != expected:
                continue
            visited = {pid}
            while parent in processes and parent not in visited and parent != launcher:
                visited.add(parent)
                parent = processes[parent][0]
            if parent == launcher:
                tray_pids.append(pid)
    add('bundle_tray_process', 'PASS' if len(tray_pids) == 1 else 'UNKNOWN', cmd,
        'One same-bundle tray descendant of the current-user launcher' if len(tray_pids) == 1 else 'No unique same-bundle descendant; launcher PID is not the tray PID')
    probe, cmd = None, 'not run (need unique bundle tray descendant and local GUI caller)'
    if len(tray_pids) == 1 and not os.environ.get('SSH_CONNECTION') and not os.environ.get('SSH_TTY'):
        rc, out, cmd = run(['python3', '-c', MAC_WINDOW_PROBE, str(tray_pids[0])])
        try:
            probe = json.loads(out) if rc == 0 else None
        except (ValueError, TypeError):
            pass
    gui = isinstance(probe, dict) and probe.get('gui') is True
    add('macos_gui_session', 'PASS' if gui else 'UNKNOWN', cmd,
        'CoreGraphics reports this UID logged in on-console in a GUI session' if gui else 'GUI session unverified; SSH is deliberately skipped, with no bootstrap/permission changes')
    windows = probe.get('windows') if gui else None
    level = probe.get('status_level') if gui else None
    classified = isinstance(windows, list) and type(level) is int and level > 0
    classified = classified and all(isinstance(w, dict) and type(w.get('kCGWindowLayer')) is int for w in windows)
    candidates = [w for w in windows if w['kCGWindowLayer'] == level] if classified else []
    status = 'UNKNOWN'
    if len(candidates) == 1:
        w = candidates[0]
        bounds = w.get('kCGWindowBounds')
        numbers = (int, float)
        complete = type(w.get('kCGWindowNumber')) is int and w['kCGWindowNumber'] > 0 and type(w.get('kCGWindowIsOnscreen')) is bool and type(w.get('kCGWindowAlpha')) in numbers and isinstance(bounds, dict) and all(type(bounds.get(k)) in numbers for k in ('X', 'Y', 'Width', 'Height'))
        complete = complete and all(math.isfinite(x) for x in [w['kCGWindowAlpha']] + [bounds[k] for k in ('X', 'Y', 'Width', 'Height')])
        if complete:
            status = 'PASS' if w['kCGWindowIsOnscreen'] and w['kCGWindowAlpha'] > 0 and bounds['Width'] > 0 and bounds['Height'] > 0 else 'FAIL'
    add('menu_bar_item', status, cmd,
        'Observed bundle only (not requested-home bound): unique target-tray on-screen status-level window with positive bounds/alpha; not image content or NSStatusItem identity' if status == 'PASS' else 'No unique usable observed-bundle target-tray status-level window established; omitted/redacted windows and permission-gated data remain UNKNOWN')
    # The observed bundle's window is not bound to the requested state home.
    # Preserve that narrower menu_bar_item evidence without upgrading its scope.
    home_bound = any(r['name'] == 'isolated_home' and r['status'] == 'PASS' for r in rows)
    drawn_status, drawn_command = (status if home_bound else 'UNKNOWN'), cmd
    drawn_detail = 'Requested-home visibility requires verified state-home identity; observed-bundle menu_bar_item metadata alone is not that binding or proof of compositor pixels'
else:
    add('platform', 'UNKNOWN', platform_cmd, 'Supported evidence adapters are Linux and Darwin')

if a.url:
    u = urlsplit(a.url)
    try:
        port = u.port
    except ValueError:
        port = None
    if u.scheme != 'http' or u.hostname not in ('127.0.0.1', '::1') or not port or u.username or u.password or u.query or u.fragment or u.path not in ('', '/'):
        add('http', 'FAIL', 'validate --url', 'Only explicit numeric loopback HTTP origin with port and no credentials/query/path is accepted')
    else:
        rc, out, cmd = run(['curl', '--disable', '--silent', '--output', '/dev/null', '--write-out', '%{http_code}',
                            '--max-time', '3', '--noproxy', '*', '--proto', '=http', a.url])
        code = out.strip()
        add('http', 'PASS' if rc == 0 and re.fullmatch(r'[23][0-9]{2}', code) else ('UNKNOWN' if rc is None else 'FAIL'), cmd,
            'Explicit loopback origin HTTP status ' + code if re.fullmatch(r'[0-9]{3}', code) else 'No valid HTTP response')
        add('http_home_identity', 'UNKNOWN', 'none (app.json intentionally not read)',
            'Response is not authenticated to requested home; explicit origin could belong to another app. Token-bearing discovery record is deliberately not read.')
else:
    add('http', 'UNKNOWN', 'none (--url not supplied)', 'Supply known loopback origin; checker never reads token-bearing v1/app.json')
add('drawn_visibility', drawn_status, drawn_command, drawn_detail)
add('compositor_pixels', 'UNKNOWN', 'not run (no screenshots, screen capture or display interaction)',
    'Semantic SHOWING/window metadata cannot establish final compositor pixels; M2 visual acceptance remains unverified')
accepted = bool(rows) and all(r['status'] == 'PASS' for r in rows)
if a.json:
    print(json.dumps(dict(checks=rows, accepted=accepted), indent=2))
else:
    for r in rows:
        print(r['status'] + ' ' + r['name'] + ': ' + r['detail'] + '\n  command: ' + r['command'])
sys.exit(0 if accepted else 1)
PY
