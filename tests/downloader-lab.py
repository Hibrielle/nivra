"""Ephemeral, loopback-only Docker fixtures. Never touches unlabelled resources.

python3 tests/downloader-lab.py up user@host artifacts/downloader-lab
python3 tests/downloader-lab.py down artifacts/downloader-lab
Credentials stay in the ignored lab directory and are removed by down.
"""
import concurrent.futures
import json
import base64
import hashlib
import io
import os
from pathlib import Path
import secrets
import shlex
import socket
import subprocess
import sys
import tarfile
import time

IMAGES = {
    'qbittorrent': 'lscr.io/linuxserver/qbittorrent:latest',
    'transmission': 'lscr.io/linuxserver/transmission:latest',
    'aria2': 'p3terx/aria2-pro:latest',
}


def ssh(target, args, data=None, timeout=300):
    result = subprocess.run(
        ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', target,
         shlex.join(args)], input=data, capture_output=True, timeout=timeout)
    if result.returncode:
        # Command arguments can contain a test credential; never print them.
        raise RuntimeError(result.stderr.decode()[-1800:])
    return result.stdout.decode().strip()


def save(path, value):
    path.write_text(json.dumps(value, indent=2))
    path.chmod(0o600)


def cleanup(directory):
    state = json.loads((directory / 'state.json').read_text())
    target, label = state['target'], 'nivra.lab=' + state['run']
    removed = {'containers': [], 'networks': [], 'images': []}
    for kind, ls, rm in [('containers', ['docker', 'ps', '-aq'], ['docker', 'rm', '-fv']),
                         ('networks', ['docker', 'network', 'ls', '-q'], ['docker', 'network', 'rm'])]:
        ids = ssh(target, ls + ['--filter', 'label=' + label]).split()
        for item in ids:
            ssh(target, rm + [item])
            removed[kind].append(item)
    # Remove only tags absent before this run; don't force removal of shared images.
    present = ssh(target, ['docker', 'image', 'ls', '--format', '{{.Repository}}:{{.Tag}}']).splitlines()
    for image in state['newImages']:
        if image not in present:
            continue
        try:
            ssh(target, ['docker', 'image', 'rm', image])
            removed['images'].append(image)
        except RuntimeError as error:
            removed.setdefault('retainedImages', []).append({'image': image, 'reason': str(error)})
    pid = state.get('tunnelPid')
    if pid:
        command = subprocess.run(['ps', '-p', str(pid), '-o', 'command='], capture_output=True, text=True).stdout
        if command.strip() == state.get('tunnelCommand'):
            os.kill(pid, 15)
    (directory / 'credentials.json').unlink(missing_ok=True)
    remaining = {
        'containers': ssh(target, ['docker', 'ps', '-aq', '--filter', 'label=' + label]),
        'networks': ssh(target, ['docker', 'network', 'ls', '-q', '--filter', 'label=' + label]),
    }
    save(directory / 'cleanup.json', {'removed': removed, 'remaining': remaining})
    print(json.dumps({'cleaned': removed, 'remaining': remaining}))


def deploy(target, directory):
    directory.mkdir(parents=True, exist_ok=True)
    directory.chmod(0o700)
    if (directory / 'state.json').exists():
        raise RuntimeError('Existing lab state: clean it before starting a new run')
    run = 'dm-test-' + secrets.token_hex(5)
    before = ssh(target, ['docker', 'image', 'ls', '--format', '{{.Repository}}:{{.Tag}}']).splitlines()
    base_image = os.environ.get('LAB_BASE_IMAGE')
    images = {kind: run + ':clients' for kind in IMAGES} if base_image else IMAGES
    state = {'run': run, 'target': target, 'newImages': list(set(i for i in images.values() if i not in before))}
    save(directory / 'state.json', state)

    def pull(pair):
        kind, image = pair
        output = ssh(target, ['docker', 'pull', image], timeout=300)
        (directory / (kind + '-pull.log')).write_text(output)
        print('Image ready: ' + kind, flush=True)

    try:
        if base_image:
            dockerfile = f'''FROM {base_image}
USER root
RUN apt-get -o Acquire::Retries=0 -o Acquire::http::Timeout=20 update && DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=0 -o Acquire::http::Timeout=20 install -y --no-install-recommends qbittorrent-nox transmission-daemon aria2
'''
            output = ssh(target, ['docker', 'build', '--rm', '--force-rm', '--label', 'nivra.lab=' + run, '-t', run + ':clients', '-'], data=dockerfile.encode(), timeout=300)
            (directory / 'build.log').write_text(output)
            print('Cached base image now contains all three clients.', flush=True)
        else:
            with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
                list(executor.map(pull, images.items()))
        label = 'nivra.lab=' + run
        ssh(target, ['docker', 'network', 'create', '--internal', '--label', label, run])
        credentials, forwards, versions = {}, [], {}
        for kind, image in images.items():
            password = secrets.token_urlsafe(24)
            sock = socket.socket()
            sock.bind(('127.0.0.1', 0))
            local_port = sock.getsockname()[1]
            sock.close()
            # qBittorrent 4.x validates that Host and listening ports agree.
            port = local_port if kind == 'qbittorrent' else {'transmission': 9091, 'aria2': 6800}[kind]
            args = ['docker', 'run', '-d', '--name', run + '-' + kind, '--label', label,
                    '--network', run, '--memory', '512m', '--cpus', '1', '--pids-limit', '128',
                    '--log-opt', 'max-size=1m',
                    '--tmpfs', '/config:rw,size=32m', '--tmpfs', '/downloads:rw,size=32m']
            if kind == 'transmission' and not base_image:
                args += ['-e', 'USER=mate-test', '-e', 'PASS=' + password]
            if kind == 'qbittorrent' and not base_image:
                args += ['-e', 'WEBUI_PORT=' + str(port)]
            if base_image and kind != 'aria2':
                if kind == 'qbittorrent':
                    args += ['-e', 'XDG_CONFIG_HOME=/config']
                    launch = 'qbittorrent-nox --webui-port=' + str(port)
                    salt = secrets.token_bytes(16)
                    key = hashlib.pbkdf2_hmac('sha512', password.encode(), salt, 100000, 64)
                    password_hash = base64.b64encode(salt).decode() + ':' + base64.b64encode(key).decode()
                    config_path = 'qBittorrent/qBittorrent.conf'
                    config_bytes = ('[LegalNotice]\nAccepted=true\n[Preferences]\n'
                                    'WebUI\\Username=admin\nWebUI\\Password_PBKDF2="@ByteArray(' + password_hash + ')"\n'
                                    'WebUI\\LocalHostAuth=true\nWebUI\\CSRFProtection=true\n'
                                    'Downloads\\SavePath=/downloads/\n').encode()
                else:
                    launch = 'transmission-daemon --foreground --config-dir /config'
                    config_path = 'settings.json'
                    config_bytes = json.dumps({'rpc-enabled': True, 'rpc-bind-address': '0.0.0.0',
                        'rpc-port': 9091, 'rpc-authentication-required': True, 'rpc-username': 'mate-test',
                        'rpc-password': password, 'rpc-whitelist-enabled': False,
                        'rpc-host-whitelist-enabled': True, 'rpc-host-whitelist': 'localhost,127.0.0.1',
                        'download-dir': '/downloads', 'dht-enabled': False, 'pex-enabled': False,
                        'lpd-enabled': False, 'port-forwarding-enabled': False}).encode()
                args += ['--entrypoint', 'sh', image, '-c', 'while [ ! -f /config/ready ]; do sleep 0.2; done; exec ' + launch]
            elif kind == 'aria2':
                args += ['--entrypoint', 'aria2c', image, '--enable-rpc=true', '--rpc-listen-all=true',
                         '--rpc-secret=' + password, '--dir=/downloads', '--enable-dht=false',
                         '--enable-dht6=false', '--bt-enable-lpd=false', '--disable-ipv6=true',
                         '--rpc-save-upload-metadata=false']
            else:
                args += [image]
            container = ssh(target, args)
            if base_image and kind != 'aria2':
                archive = io.BytesIO()
                with tarfile.open(fileobj=archive, mode='w') as tar:
                    for name, content in [(config_path, config_bytes), ('ready', b'')]:
                        info = tarfile.TarInfo(name)
                        info.size = len(content)
                        info.mode = 0o600
                        tar.addfile(info, io.BytesIO(content))
                ssh(target, ['docker', 'exec', '-i', container, 'tar', '-xf', '-', '-C', '/config'], data=archive.getvalue())
            # Docker 20 does not publish ports on an internal bridge. The SSH
            # host can reach the private bridge address without any LAN port.
            network_info = json.loads(ssh(target, ['docker', 'inspect', container, '--format', '{{json .NetworkSettings.Networks}}']))
            remote_address = network_info[run]['IPAddress']
            if not remote_address:
                raise RuntimeError(kind + ' exited before receiving its internal address')
            forwards += ['-L', f'127.0.0.1:{local_port}:{remote_address}:{port}']
            if kind == 'qbittorrent' and not base_image:
                for _ in range(60):
                    logs = ssh(target, ['docker', 'logs', container], timeout=20)
                    line = next((l for l in logs.splitlines() if 'temporary password is provided' in l), None)
                    if line:
                        password = line.rsplit(':', 1)[-1].strip()
                        break
                    time.sleep(1)
                else:
                    raise RuntimeError('qBittorrent did not become ready')
            credentials[kind] = {
                'type': kind, 'url': f'http://127.0.0.1:{local_port}',
                'username': 'admin' if kind == 'qbittorrent' else 'mate-test' if kind == 'transmission' else '',
                'secret': password,
            }
            versions[kind] = {'image': image, 'container': container,
                              'digest': json.loads(ssh(target, ['docker', 'image', 'inspect', image, '--format', '{{json .RepoDigests}}']))}
        command = ['ssh', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
                   '-o', 'ServerAliveInterval=30', '-N', *forwards, target]
        log = open(directory / 'tunnel.log', 'w')
        tunnel = subprocess.Popen(command, stdout=log, stderr=log, start_new_session=True)
        state['tunnelPid'] = tunnel.pid
        time.sleep(2)
        if tunnel.poll() is not None:
            raise RuntimeError('SSH tunnel failed')
        state['tunnelCommand'] = subprocess.run(['ps', '-p', str(tunnel.pid), '-o', 'command='], capture_output=True, text=True).stdout.strip()
        save(directory / 'state.json', state)
        save(directory / 'credentials.json', credentials)
        save(directory / 'images.json', versions)
        print('Lab ready: three isolated containers, loopback SSH tunnel, credentials saved locally.', flush=True)
    except BaseException:
        cleanup(directory)
        raise


if __name__ == '__main__':
    if sys.argv[1] == 'up':
        deploy(sys.argv[2], Path(sys.argv[3]).resolve())
    elif sys.argv[1] == 'down':
        cleanup(Path(sys.argv[2]).resolve())
    else:
        raise SystemExit('Use up or down')
