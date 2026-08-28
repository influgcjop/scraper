/**
 * askClaude — invoca `claude -p` como subproceso, pasando el prompt por
 * stdin (evita problemas de escaping con bios que traen comillas/emojis).
 * Se usa para clasificaciones ligeras (ciudad, nicho) sobre texto que ya
 * scrapeamos, no para volver a llamar a Apify.
 */
import { spawn } from 'node:child_process';

export function askClaude(prompt, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('claude -p: timeout'));
    }, timeoutMs);

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude -p: exit ${code} — ${stderr.trim()}`));
      resolve(stdout.trim());
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/** Extrae el primer objeto JSON de una respuesta de texto, por si el modelo agrega algo alrededor. */
export function parseJsonResponse(raw) {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`sin JSON en la respuesta: ${raw.slice(0, 200)}`);
  return JSON.parse(match[0]);
}
