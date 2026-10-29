import { spawn } from 'node:child_process';

export function ask(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', '--output-format', 'text']);
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err || `claude exited ${code}`))));
    child.stdin.end(prompt);
  });
}

export function parseJson<T>(raw: string, open: '[' | '{', close: ']' | '}'): T {
  const start = raw.indexOf(open);
  const end = raw.lastIndexOf(close);
  if (start === -1 || end === -1) throw new Error(`No JSON in model output:\n${raw}`);
  return JSON.parse(raw.slice(start, end + 1)) as T;
}
