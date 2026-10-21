import { realpath, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';

export type WorkingDirectoryRejectReason =
  | 'empty-requested-cwd'
  | 'path-inaccessible'
  | 'not-directory'
  | 'filesystem-root'
  | 'home-root'
  | 'user-root'
  | 'system-root'
  | 'temp-root'
  | 'broad-user-folder'
  | 'volume-root';

export type WorkingDirectoryResolveResult =
  | { ok: true; requestedCwd: string; cwdRealpath: string }
  | {
      ok: false;
      reason: WorkingDirectoryRejectReason;
      requestedCwd: string;
      userVisible: string;
    };

export async function resolveWorkingDirectory(
  requestedCwd: string,
): Promise<WorkingDirectoryResolveResult> {
  const trimmed = requestedCwd.trim();
  if (!trimmed) {
    return reject('empty-requested-cwd', requestedCwd, 'No workspace specified.');
  }

  let resolved: string;
  try {
    resolved = await realpath(trimmed);
  } catch {
    return reject('path-inaccessible', requestedCwd, `Workspace does not exist or is not accessible: ${requestedCwd}`);
  }

  const info = await stat(resolved).catch(() => undefined);
  if (!info?.isDirectory()) {
    return reject('not-directory', requestedCwd, `Path is not a directory: ${resolved}`);
  }

  const tempRealpath = await realpath(tmpdir()).catch(() => resolve(tmpdir()));
  const homeRealpath = await realpath(homedir()).catch(() => resolve(homedir()));
  const broad = classifyHighRiskWorkingDirectory(resolved, requestedCwd, tempRealpath, homeRealpath);
  if (broad) return broad;

  return {
    ok: true,
    requestedCwd,
    cwdRealpath: resolved,
  };
}

function reject(
  reason: WorkingDirectoryRejectReason,
  requestedCwd: string,
  userVisible: string,
): WorkingDirectoryResolveResult {
  return { ok: false, reason, requestedCwd, userVisible };
}

function classifyHighRiskWorkingDirectory(
  real: string,
  requestedCwd: string,
  tempRealpath: string,
  homeRealpath: string,
): WorkingDirectoryResolveResult | undefined {
  if (real === dirname(real)) {
    return reject('filesystem-root', requestedCwd, 'The filesystem root cannot be used as the workspace.');
  }

  const home = homeRealpath;
  if (real === home) {
    return reject('home-root', requestedCwd, 'The home directory itself cannot be used as the workspace. Please pick a more specific subfolder.');
  }
  if (real === dirname(home)) {
    return reject('user-root', requestedCwd, 'The users root directory cannot be used as the workspace. Please pick a more specific subfolder.');
  }

  if (dirname(real) === home && new Set(['Desktop', 'Downloads']).has(basename(real))) {
    return reject('broad-user-folder', requestedCwd, 'This folder is too broad. Please pick a more specific subfolder.');
  }

  const temp = resolve(tmpdir());
  if (real === temp || real === tempRealpath || real === '/tmp' || real === '/private/tmp') {
    return reject('temp-root', requestedCwd, 'The temp directory root cannot be used as the workspace. Please pick a more specific subfolder.');
  }

  const systemRoots = new Set([
    '/Applications',
    '/bin',
    '/etc',
    '/Library',
    '/private',
    '/sbin',
    '/System',
    '/usr',
    '/var',
  ]);
  if (systemRoots.has(real)) {
    return reject('system-root', requestedCwd, 'A system directory cannot be used as the workspace.');
  }

  if (real === '/Volumes' || dirname(real) === '/Volumes') {
    return reject('volume-root', requestedCwd, 'A drive/volume root cannot be used as the workspace. Please pick a more specific subfolder.');
  }

  return undefined;
}
