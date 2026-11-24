import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { samePath } from './paths.mjs';

const exec = promisify(execFile);
const isNode = (binary) => samePath(binary, process.execPath) || /^node(?:js|\.exe)?$/i.test(path.basename(binary));

function linuxIdentity(pid, dir, files) {
  const proc = `/proc/${pid}`;
  if (fs.statSync(proc).uid !== process.getuid()) return null;
  const [, script, configDir] = fs.readFileSync(`${proc}/cmdline`, 'utf8').split('\0');
  if (!samePath(configDir, dir) || !files.some((file) => samePath(file, script))) return null;
  const stat = fs.readFileSync(`${proc}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
}

async function macIdentity(pid, dir, configDirArg, files) {
  const { stdout } = await exec('/bin/ps', ['-ww', '-p', String(pid), '-o', 'uid=', '-o', 'lstart=', '-o', 'command='], {
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, timeout: 2000,
  });
  const fields = /^\s*(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/.exec(stdout);
  if (!fields || Number(fields[1]) !== process.getuid()) return null;
  const [, , start, command] = fields;
  // ps joins the arguments with spaces. Match the complete suffix using the known paths.
  const dirs = samePath(configDirArg, dir) ? [dir, configDirArg] : [dir];
  const matches = files.some((file) => dirs.some((candidate) => {
    const suffix = ` ${file} ${candidate}`;
    return command.endsWith(suffix) && isNode(command.slice(0, -suffix.length));
  }));
  return matches ? start : null;
}

async function windowsIdentity(pid, dir, files) {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const code = `
    $ErrorActionPreference = 'Stop'
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $p = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${pid}'
    if (-not $p) { exit }
    $owner = Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid
    if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { exit }
    @{ command = $p.CommandLine; start = $p.CreationDate.ToUniversalTime().Ticks.ToString() } | ConvertTo-Json -Compress
  `;
  const { stdout } = await exec(powershell, ['-NoProfile', '-NonInteractive', '-Command', code], {
    windowsHide: true, timeout: 5000,
  });
  const { command, start } = JSON.parse(stdout);
  // These three arguments are paths or an executable name. Windows paths cannot contain quotes.
  const args = Array.from(command.matchAll(/"([^"]*)"|([^\s"]+)/g), (m) => m[1] ?? m[2]);
  if (args.length !== 3 || !isNode(args[0]) || !samePath(args[2], dir)) return null;
  return files.some((file) => samePath(file, args[1])) ? start : null;
}

export async function routerIdentity(info, dir, files) {
  if (info?.ok !== true || !samePath(info.configDir, dir) || !Number.isSafeInteger(info.pid) || info.pid < 2 || info.pid > 0xffffffff) return null;
  const { pid } = info;
  try {
    let start;
    if (process.platform === 'linux') start = linuxIdentity(pid, dir, files);
    else if (process.platform === 'darwin') start = await macIdentity(pid, dir, info.configDirArg, files);
    else if (process.platform === 'win32') start = await windowsIdentity(pid, dir, files);
    return start ? { pid, start } : null;
  } catch {
    return null; // An inaccessible or exited process is never a signal target.
  }
}
