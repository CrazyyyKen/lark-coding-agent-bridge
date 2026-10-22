import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

export async function promptLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: Boolean(process.stdin.isTTY),
    });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function promptPassword(prompt: string): Promise<string> {
  const isTTY = Boolean(process.stdin.isTTY);
  return new Promise((resolve) => {
    const muted = new Writable({
      write(_chunk: Buffer | string, _enc, cb) {
        cb();
      },
    });
    process.stdout.write(prompt);
    const rl = createInterface({
      input: process.stdin,
      output: isTTY ? muted : process.stdout,
      terminal: isTTY,
    });
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

export async function readAllStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''; // no input piped
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}
