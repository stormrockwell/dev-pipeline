import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sync = path.join(__dirname, 'sync.mjs');
const contentDir = path.join(__dirname, 'content');

let tempDir;

beforeEach(() => {
  tempDir = path.join(tmpdir(), `docs-sync-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true });
  }
  if (fs.existsSync(contentDir)) {
    fs.rmSync(contentDir, { recursive: true });
  }
});

function runSync(srcDir) {
  const result = spawnSync('node', [sync], {
    cwd: tempDir,
    env: { ...process.env, DOCS_SRC: srcDir },
    encoding: 'utf8',
    timeout: 10_000,
  });
  return result;
}

describe('sync.mjs', () => {
  describe('top-level markdown files', () => {
    it('copies top-level .md files to content directory', () => {
      const srcDir = path.join(tempDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'README.md'), '# README\nTop-level file');
      fs.writeFileSync(path.join(srcDir, 'GUIDE.md'), '# Guide\nAnother file');

      const result = runSync(srcDir);

      expect(result.status).toBe(0);
      expect(fs.existsSync(path.join(contentDir, 'README.md'))).toBe(true);
      expect(fs.existsSync(path.join(contentDir, 'GUIDE.md'))).toBe(true);
      const content = fs.readFileSync(path.join(contentDir, 'README.md'), 'utf8');
      expect(content).toBe('# README\nTop-level file');
    });
  });

  describe('nested docs directory', () => {
    it('copies docs/**/*.md files keeping nested structure', () => {
      const srcDir = path.join(tempDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.mkdirSync(path.join(srcDir, 'docs', 'guides', 'nested'), { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'docs', 'guides', 'guide1.md'), '# Guide 1');
      fs.writeFileSync(path.join(srcDir, 'docs', 'guides', 'nested', 'guide2.md'), '# Guide 2');

      const result = runSync(srcDir);

      expect(result.status).toBe(0);
      expect(fs.existsSync(path.join(contentDir, 'guides', 'guide1.md'))).toBe(true);
      expect(fs.existsSync(path.join(contentDir, 'guides', 'nested', 'guide2.md'))).toBe(true);
    });

    it('handles deep nesting in docs directory', () => {
      const srcDir = path.join(tempDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.mkdirSync(path.join(srcDir, 'docs', 'a', 'b', 'c', 'd'), { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'docs', 'a', 'b', 'c', 'd', 'deep.md'), '# Deep file');

      const result = runSync(srcDir);

      expect(result.status).toBe(0);
      expect(fs.existsSync(path.join(contentDir, 'a', 'b', 'c', 'd', 'deep.md'))).toBe(true);
    });
  });

  describe('non-markdown files', () => {
    it('skips non-markdown files in top-level directory', () => {
      const srcDir = path.join(tempDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'README.md'), '# README');
      fs.writeFileSync(path.join(srcDir, 'script.js'), 'console.log("ignored");');
      fs.writeFileSync(path.join(srcDir, 'data.json'), '{"ignored": true}');
      fs.writeFileSync(path.join(srcDir, 'image.png'), 'fake png data');

      const result = runSync(srcDir);

      expect(result.status).toBe(0);
      expect(fs.existsSync(path.join(contentDir, 'README.md'))).toBe(true);
      expect(fs.existsSync(path.join(contentDir, 'script.js'))).toBe(false);
      expect(fs.existsSync(path.join(contentDir, 'data.json'))).toBe(false);
      expect(fs.existsSync(path.join(contentDir, 'image.png'))).toBe(false);
    });

    it('skips non-markdown files in docs subdirectories', () => {
      const srcDir = path.join(tempDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.mkdirSync(path.join(srcDir, 'docs', 'guides'), { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'docs', 'guides', 'guide.md'), '# Guide');
      fs.writeFileSync(path.join(srcDir, 'docs', 'guides', 'style.css'), 'body { color: red; }');
      fs.writeFileSync(path.join(srcDir, 'docs', 'guides', 'config.yaml'), 'key: value');

      const result = runSync(srcDir);

      expect(result.status).toBe(0);
      expect(fs.existsSync(path.join(contentDir, 'guides', 'guide.md'))).toBe(true);
      expect(fs.existsSync(path.join(contentDir, 'guides', 'style.css'))).toBe(false);
      expect(fs.existsSync(path.join(contentDir, 'guides', 'config.yaml'))).toBe(false);
    });
  });

  describe('excluded directories', () => {
    it('skips node_modules, research, vendor, tools, and .git directories', () => {
      const srcDir = path.join(tempDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.mkdirSync(path.join(srcDir, 'node_modules', 'lib'), { recursive: true });
      fs.mkdirSync(path.join(srcDir, 'research'), { recursive: true });
      fs.mkdirSync(path.join(srcDir, 'vendor'), { recursive: true });
      fs.mkdirSync(path.join(srcDir, 'tools'), { recursive: true });
      fs.mkdirSync(path.join(srcDir, '.git'), { recursive: true });

      fs.writeFileSync(path.join(srcDir, 'node_modules', 'lib', 'index.md'), '# Node Module');
      fs.writeFileSync(path.join(srcDir, 'research', 'notes.md'), '# Research');
      fs.writeFileSync(path.join(srcDir, 'vendor', 'lib.md'), '# Vendor');
      fs.writeFileSync(path.join(srcDir, 'tools', 'util.md'), '# Tool');
      fs.writeFileSync(path.join(srcDir, '.git', 'config.md'), '# Git Config');
      fs.writeFileSync(path.join(srcDir, 'README.md'), '# Main');

      const result = runSync(srcDir);

      expect(result.status).toBe(0);
      expect(fs.existsSync(path.join(contentDir, 'README.md'))).toBe(true);
      expect(fs.existsSync(path.join(contentDir, 'node_modules'))).toBe(false);
      expect(fs.existsSync(path.join(contentDir, 'research'))).toBe(false);
      expect(fs.existsSync(path.join(contentDir, 'vendor'))).toBe(false);
      expect(fs.existsSync(path.join(contentDir, 'tools'))).toBe(false);
      expect(fs.existsSync(path.join(contentDir, '.git'))).toBe(false);
    });
  });

  describe('deleted source files', () => {
    it('removes deleted files on next sync', () => {
      const srcDir = path.join(tempDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'file1.md'), '# File 1');
      fs.writeFileSync(path.join(srcDir, 'file2.md'), '# File 2');

      let result = runSync(srcDir);
      expect(result.status).toBe(0);
      expect(fs.existsSync(path.join(contentDir, 'file1.md'))).toBe(true);
      expect(fs.existsSync(path.join(contentDir, 'file2.md'))).toBe(true);

      fs.unlinkSync(path.join(srcDir, 'file1.md'));

      result = runSync(srcDir);
      expect(result.status).toBe(0);
      expect(fs.existsSync(path.join(contentDir, 'file1.md'))).toBe(false);
      expect(fs.existsSync(path.join(contentDir, 'file2.md'))).toBe(true);
    });

    it('handles deletion of entire nested directory', () => {
      const srcDir = path.join(tempDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.mkdirSync(path.join(srcDir, 'docs', 'guides'), { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'docs', 'guides', 'guide.md'), '# Guide');

      let result = runSync(srcDir);
      expect(result.status).toBe(0);
      expect(fs.existsSync(path.join(contentDir, 'guides', 'guide.md'))).toBe(true);

      fs.rmSync(path.join(srcDir, 'docs', 'guides'), { recursive: true });

      result = runSync(srcDir);
      expect(result.status).toBe(0);
      expect(fs.existsSync(path.join(contentDir, 'guides', 'guide.md'))).toBe(false);
    });
  });

  describe('sidebar.json generation', () => {
    it('creates sidebar.json with correct structure', () => {
      const srcDir = path.join(tempDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'README.md'), '# Read Me');
      fs.writeFileSync(path.join(srcDir, 'STRATEGY.md'), '# Strategy');

      const result = runSync(srcDir);

      expect(result.status).toBe(0);
      const sidebarPath = path.join(contentDir, 'sidebar.json');
      expect(fs.existsSync(sidebarPath)).toBe(true);
      const sidebar = JSON.parse(fs.readFileSync(sidebarPath, 'utf8'));
      expect(Array.isArray(sidebar)).toBe(true);
      expect(sidebar.length).toBeGreaterThan(0);
    });

    it('puts STRATEGY.md first in sidebar', () => {
      const srcDir = path.join(tempDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'README.md'), '# Read Me');
      fs.writeFileSync(path.join(srcDir, 'STRATEGY.md'), '# Strategy');
      fs.writeFileSync(path.join(srcDir, 'GUIDE.md'), '# Guide');

      const result = runSync(srcDir);

      expect(result.status).toBe(0);
      const sidebarPath = path.join(contentDir, 'sidebar.json');
      const sidebar = JSON.parse(fs.readFileSync(sidebarPath, 'utf8'));
      expect(sidebar[0].link).toBe('/STRATEGY');
    });
  });

  describe('index.md generation', () => {
    it('creates index.md with all documents', () => {
      const srcDir = path.join(tempDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'README.md'), '# Read Me');
      fs.writeFileSync(path.join(srcDir, 'GUIDE.md'), '# Guide');

      const result = runSync(srcDir);

      expect(result.status).toBe(0);
      const indexPath = path.join(contentDir, 'index.md');
      expect(fs.existsSync(indexPath)).toBe(true);
      const indexContent = fs.readFileSync(indexPath, 'utf8');
      expect(indexContent).toContain('# Dev Pipeline Docs');
      expect(indexContent).toContain('[Read Me](/README)');
      expect(indexContent).toContain('[Guide](/GUIDE)');
    });
  });

  describe('title extraction', () => {
    it('extracts H1 title from markdown files', () => {
      const srcDir = path.join(tempDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'README.md'), '# Custom Title\nContent here');

      const result = runSync(srcDir);

      expect(result.status).toBe(0);
      const sidebarPath = path.join(contentDir, 'sidebar.json');
      const sidebar = JSON.parse(fs.readFileSync(sidebarPath, 'utf8'));
      const readmeEntry = sidebar.find(s => s.link === '/README');
      expect(readmeEntry.text).toBe('Custom Title');
    });

    it('uses filename when H1 is missing', () => {
      const srcDir = path.join(tempDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'README.md'), 'No heading here\nJust content');

      const result = runSync(srcDir);

      expect(result.status).toBe(0);
      const sidebarPath = path.join(contentDir, 'sidebar.json');
      const sidebar = JSON.parse(fs.readFileSync(sidebarPath, 'utf8'));
      const readmeEntry = sidebar.find(s => s.link === '/README');
      expect(readmeEntry.text).toBe('README');
    });
  });

  describe('watch mode', () => {
    it('re-syncs a changed file in watch mode', async () => {
      const srcDir = path.join(tempDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'test.md'), '# Test\nInitial content');

      const proc = spawn('node', [sync, '--watch'], {
        cwd: tempDir,
        env: { ...process.env, DOCS_SRC: srcDir },
        stdio: 'pipe',
        timeout: 10_000,
      });

      let syncedCount = 0;

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          proc.kill();
          reject(new Error('Timeout waiting for sync'));
        }, 8000);

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

        proc.on('exit', () => {
          clearTimeout(timer);
          if (syncedCount >= 2) {
            resolve();
          }
        });
      });
    }, 12_000);

    it('exits when killed', () => {
      return new Promise((resolve, reject) => {
        const srcDir = path.join(tempDir, 'src');
        fs.mkdirSync(srcDir, { recursive: true });
        fs.writeFileSync(path.join(srcDir, 'test.md'), '# Test');

        const proc = spawn('node', [sync, '--watch'], {
          cwd: tempDir,
          env: { ...process.env, DOCS_SRC: srcDir },
          stdio: 'pipe',
          timeout: 5_000,
        });

        let exited = false;
        setTimeout(() => {
          proc.kill();
        }, 500);

        const timer = setTimeout(() => {
          if (!exited) {
            proc.kill('SIGKILL');
            reject(new Error('Process did not exit within timeout'));
          }
        }, 3000);

        proc.on('exit', (code, signal) => {
          clearTimeout(timer);
          exited = true;
          if (code === null || signal !== null) {
            resolve();
          } else if (code === 0) {
            resolve();
          } else {
            reject(new Error(`Process exited with code ${code}`));
          }
        });
      });
    }, 5_000);
  });

  describe('content directory management', () => {
    it('creates content directory if it does not exist', () => {
      const srcDir = path.join(tempDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'README.md'), '# README');

      expect(fs.existsSync(contentDir)).toBe(false);

      const result = runSync(srcDir);

      expect(result.status).toBe(0);
      expect(fs.existsSync(contentDir)).toBe(true);
    });

    it('empties existing content directory before syncing', () => {
      const srcDir = path.join(tempDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.mkdirSync(contentDir, { recursive: true });
      fs.writeFileSync(path.join(contentDir, 'old-file.md'), 'old content');
      fs.writeFileSync(path.join(srcDir, 'new-file.md'), '# New');

      const result = runSync(srcDir);

      expect(result.status).toBe(0);
      expect(fs.existsSync(path.join(contentDir, 'old-file.md'))).toBe(false);
      expect(fs.existsSync(path.join(contentDir, 'new-file.md'))).toBe(true);
    });
  });

  describe('argument parsing with watch flag', () => {
    it('processes arguments and runs initial sync', () => {
      const srcDir = path.join(tempDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'test.md'), '# Test');

      const result = spawnSync('node', [sync, '--watch'], {
        cwd: tempDir,
        env: { ...process.env, DOCS_SRC: srcDir },
        encoding: 'utf8',
        timeout: 3_000,
        killSignal: 'SIGTERM',
      });

      expect(result.stdout || result.stderr).toContain('Synced');
    }, 8_000);
  });
});
