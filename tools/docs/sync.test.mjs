import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sync = path.join(__dirname, 'sync.mjs');

let tempDir;

beforeEach(() => {
  tempDir = path.join(tmpdir(), `docs-sync-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true });
  }
});

describe('sync.mjs', () => {
  it('re-syncs a changed file in watch mode', async () => {
    const srcDir = path.join(tempDir, 'src');
    const contentDir = path.join(tempDir, 'content');

    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'test.md'), '# Test\nInitial content');

    const proc = spawn('node', [sync, '--watch'], {
      cwd: tempDir,
      env: { ...process.env, DOCS_SRC: srcDir },
      stdio: 'pipe'
    });

    let syncedCount = 0;
    let hasError = false;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error('Timeout waiting for sync'));
      }, 5000);

      proc.stdout.on('data', (data) => {
        const output = data.toString();
        if (output.includes('Synced')) {
          syncedCount++;
          if (syncedCount === 1) {
            setTimeout(() => {
              fs.writeFileSync(path.join(srcDir, 'test.md'), '# Test\nUpdated content');
            }, 100);
          } else if (syncedCount === 2) {
            clearTimeout(timer);
            proc.kill();
            resolve();
          }
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      proc.on('exit', (code) => {
        clearTimeout(timer);
        if (!hasError && syncedCount === 2) {
          resolve();
        } else if (hasError) {
          reject(new Error('Process error'));
        }
      });
    });
  });

  it('exits cleanly when killed', (done) => {
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'test.md'), '# Test');

    const proc = spawn('node', [sync, '--watch'], {
      cwd: tempDir,
      env: { ...process.env, DOCS_SRC: srcDir },
      stdio: 'pipe'
    });

    setTimeout(() => {
      proc.kill();
    }, 500);

    proc.on('exit', (code, signal) => {
      expect(signal).toBe('SIGTERM');
      done();
    });

    const timeout = setTimeout(() => {
      proc.kill('SIGKILL');
      done(new Error('Process did not exit cleanly'));
    }, 3000);

    proc.on('exit', () => {
      clearTimeout(timeout);
    });
  });
});
