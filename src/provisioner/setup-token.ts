import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

/**
 * One run of `claude setup-token`: the approval link it printed, and a way to
 * hand it the code the seat holder pastes back. The process keeps the PKCE
 * verifier, so it has to stay alive between the two.
 */
export interface SetupTokenSession {
  url: string;
  /** Pastes the code; resolves with the one-year token (sk-ant-oat01-…). */
  submit(code: string): Promise<string>;
  cancel(): void;
}

export type SetupTokenStarter = () => Promise<SetupTokenSession>;

// The link arrives as an OSC 8 hyperlink and as plain text; the hyperlink target is never wrapped.
const OSC8_URL_RE = /\u001b\]8;[^;]*;(https:\/\/claude\.(?:com|ai)\/[^\u0007\u001b\s]*oauth\/authorize\?[^\u0007\u001b\s]+)/;
const PLAIN_URL_RE = /(https:\/\/claude\.(?:com|ai)\/\S*oauth\/authorize\?[^\s\u0007\u001b]+)/;
const TOKEN_RE = /(sk-ant-oat01-[A-Za-z0-9_-]{20,})/;
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function findAuthorizeUrl(raw: string): string | undefined {
  return OSC8_URL_RE.exec(raw)?.[1] ?? PLAIN_URL_RE.exec(raw.replace(ANSI_RE, ''))?.[1];
}

export function findToken(raw: string): string | undefined {
  return TOKEN_RE.exec(raw.replace(ANSI_RE, ''))?.[1];
}

/**
 * The readable lines of setup-token's screen output, oldest first: escape codes gone
 * (cursor moves become spaces), repeats and blank lines dropped, tokens masked.
 */
export function screenLines(raw: string): string[] {
  const text = raw
    .replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[\d*[CG]/g, ' ')
    .replace(ANSI_RE, '')
    .replace(/\u001b[()][0-9A-Za-z]/g, '') // character-set switches, e.g. ESC ( B
    .replace(/\u001b./g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-…(masked)');
  const lines: string[] = [];
  for (const line of text.split(/[\r\n]+/)) {
    const t = line.replace(/\s+/g, ' ').trim();
    if (t.length < 2 || /^[.█▀▄▌▐░▒▓\s*]+$/.test(t) || lines[lines.length - 1] === t) continue;
    lines.push(t);
  }
  return lines;
}

/** "OAuth error: Request failed with status code 400", as setup-token prints a rejected code. */
export function findOAuthError(raw: string): string | undefined {
  return /OAuth error:[^\r\n\u001b]*/.exec(raw.replace(ANSI_RE, ''))?.[0].trim();
}

/** Label on every setup-token container, so leftovers can be found and removed. */
export const SIGNIN_LABEL = 'lark-claude-signin=1';

/** Removes setup-token containers left by an earlier provisioner run. */
export function removeLeftoverSignIns(spawn: typeof nodeSpawn = nodeSpawn): Promise<void> {
  return new Promise((resolve) => {
    const ps = spawn('docker', ['ps', '-aq', '--filter', `label=${SIGNIN_LABEL}`], { stdio: ['ignore', 'pipe', 'ignore'] });
    let ids = '';
    ps.stdout?.on('data', (d: Buffer) => (ids += d.toString()));
    ps.on('error', () => resolve());
    ps.on('close', () => {
      const list = ids.split(/\s+/).filter(Boolean);
      if (!list.length) return resolve();
      const rm = spawn('docker', ['rm', '-f', ...list], { stdio: 'ignore' });
      rm.on('error', () => resolve());
      rm.on('close', () => resolve());
    });
  });
}

const URL_TIMEOUT_MS = 60_000;
const TOKEN_TIMEOUT_MS = 90_000;
const ENTER_DELAY_MS = 700;

/**
 * Runs setup-token in a throwaway container of the bot image. It wants a
 * terminal, so `script` provides one; a very wide one, so neither the link nor
 * the token is wrapped across lines.
 */
export function dockerSetupToken(image: string, spawn: typeof nodeSpawn = nodeSpawn): SetupTokenStarter {
  return () =>
    new Promise((resolve, reject) => {
      // Named and labelled: stopping the docker client leaves its container running,
      // so ending a session removes the container by name (and startup removes leftovers).
      const name = `lark-claude-signin-${randomBytes(4).toString('hex')}`;
      const child = spawn(
        'docker',
        [
          'run', '--rm', '-i', '--name', name, '--label', SIGNIN_LABEL, '--entrypoint', '', '-e', 'TERM=xterm-256color', image,
          'script', '-qec', 'stty cols 2000 rows 50; claude setup-token', '/dev/null',
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      let output = '';
      // Output since the code was pasted, kept apart: the screen redraws keep `output`
      // growing (and trimmed), so an offset into it isn't reliable.
      let sinceSubmit: string | undefined;
      let waiter: ((raw: string) => void) | undefined;
      const onData = (d: Buffer) => {
        const text = d.toString('utf8');
        output = (output + text).slice(-200_000);
        if (sinceSubmit !== undefined) sinceSubmit = (sinceSubmit + text).slice(-50_000);
        waiter?.(sinceSubmit ?? output);
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);

      const kill = () => {
        if (child.exitCode === null) child.kill('SIGTERM');
        const rm = spawn('docker', ['rm', '-f', name], { stdio: 'ignore' });
        rm.on('error', () => undefined);
      };
      const urlTimer = setTimeout(() => {
        kill();
        reject(new Error('claude setup-token printed no sign-in link within a minute'));
      }, URL_TIMEOUT_MS);
      child.on('close', () => {
        clearTimeout(urlTimer);
        waiter?.(output);
      });

      const done = () => child.exitCode !== null || child.signalCode !== null;

      waiter = (raw) => {
        const url = findAuthorizeUrl(raw);
        if (url) {
          clearTimeout(urlTimer);
          waiter = undefined;
          resolve({
            url,
            cancel: kill,
            submit: (code) =>
              new Promise((res, rej) => {
                if (done()) return rej(new Error('This sign-in link has expired.'));
                sinceSubmit = '';
                const finish = (err?: Error, token?: string) => {
                  clearTimeout(timer);
                  waiter = undefined;
                  kill();
                  if (token) res(token);
                  else rej(err);
                };
                const timer = setTimeout(() => {
                  // Say what Claude is showing instead, so the card (and the log) explain it.
                  const shown = screenLines(sinceSubmit ?? '');
                  const err = new Error(
                    `Claude returned no token within ${TOKEN_TIMEOUT_MS / 1000} s. Its screen ended with: "${shown.slice(-3).join(' / ') || '(nothing new)'}"`,
                  );
                  (err as Error & { screen?: string[]; raw?: string }).screen = shown.slice(-25);
                  // Raw bytes (masked), for the log: the screen summary can hide what went wrong.
                  (err as Error & { raw?: string }).raw = JSON.stringify(
                    (sinceSubmit ?? '').replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-…').slice(-1500),
                  );
                  finish(err);
                }, TOKEN_TIMEOUT_MS);
                waiter = (after) => {
                  const token = findToken(after);
                  if (token) return finish(undefined, token);
                  // A wrong or stale code: setup-token shows the error and waits for Enter.
                  const oauth = findOAuthError(after);
                  if (oauth) return finish(new Error(`Claude rejected the code (${oauth}).`));
                  if (done()) finish(new Error('Claude stopped before returning a token.'));
                };
                // Like a terminal: the code as one bracketed paste (the prompt turns bracketed
                // paste on), then Enter as its own keypress. Code and Enter in one burst can be
                // taken as an unfinished paste, and the Enter is lost.
                child.stdin.write(`\u001b[200~${code.trim()}\u001b[201~`);
                setTimeout(() => {
                  if (!done()) child.stdin.write('\r');
                }, ENTER_DELAY_MS);
              }),
          });
        } else if (done()) {
          clearTimeout(urlTimer);
          reject(new Error('claude setup-token stopped before printing a sign-in link'));
        }
      };
    });
}
