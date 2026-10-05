import { spawn } from 'node:child_process';

async function launch(): Promise<void> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 1048576) throw new Error('payload limit');
    chunks.push(buffer);
  }
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
    binary: string; argv: string[]; env: Record<string, string>;
  };
  if (typeof payload.binary !== 'string' || !payload.binary || payload.binary.includes('\0')
    || !Array.isArray(payload.argv) || payload.argv.some(value => typeof value !== 'string' || value.includes('\0'))
    || !payload.env || Array.isArray(payload.env) || typeof payload.env !== 'object'
    || Object.entries(payload.env).some(([name, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
      || typeof value !== 'string' || value.includes('\0'))) throw new Error('invalid payload');
  const child = spawn(payload.binary, payload.argv, { env: payload.env, stdio: ['ignore', 'inherit', 'inherit'] });
  const terminate = () => { child.kill('SIGTERM'); };
  const interrupt = () => { child.kill('SIGINT'); };
  process.on('SIGTERM', terminate);
  process.on('SIGINT', interrupt);
  child.once('error', () => { process.exitCode = 127; });
  child.once('close', (code, signal) => {
    process.removeListener('SIGTERM', terminate);
    process.removeListener('SIGINT', interrupt);
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 127;
  });
}

void launch().catch(() => {
  process.stderr.write('private launcher refused payload\n');
  process.exitCode = 2;
});
