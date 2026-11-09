import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = process.env.DOCS_SRC || path.resolve(__dirname, '../..');
const contentDir = path.join(__dirname, 'content');

// Excluded patterns
const excluded = new Set(['node_modules', 'research', 'vendor', 'tools', '.git']);

function isExcluded(name) {
  return excluded.has(name) || name.startsWith('.');
}

function collectMdFiles(dir, baseDir = dir) {
  const files = [];
  const entries = fs.readdirSync(dir);

  for (const entry of entries) {
    if (isExcluded(entry)) continue;

    const fullPath = path.join(dir, entry);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      files.push(...collectMdFiles(fullPath, baseDir));
    } else if (entry.endsWith('.md')) {
      const relPath = path.relative(baseDir, fullPath);
      files.push(relPath);
    }
  }

  return files;
}

function performSync() {
  // Empty content directory
  if (fs.existsSync(contentDir)) {
    fs.rmSync(contentDir, { recursive: true });
  }
  fs.mkdirSync(contentDir, { recursive: true });

  // Collect top-level .md files
  const topLevelMds = fs.readdirSync(srcRoot)
    .filter(name => !isExcluded(name) && name.endsWith('.md'))
    .map(name => name);

  // Collect docs folder files, keeping the source path separate from the published name
  let docsFiles = [];
  const docsPath = path.join(srcRoot, 'docs');
  if (fs.existsSync(docsPath)) {
    docsFiles = collectMdFiles(docsPath, srcRoot);
  }

  // Combine and deduplicate by published name, so docs/X.md publishes at /X
  const sources = new Map();
  for (const name of topLevelMds) sources.set(name, name);
  for (const rel of docsFiles) sources.set(rel.replace(/^docs\//, ''), rel);
  const allMdFiles = Array.from(sources.keys()).sort();

  // Copy files and extract titles
  const docs = [];
  for (const mdFile of allMdFiles) {
    const srcFile = path.join(srcRoot, sources.get(mdFile));
    const destFile = path.join(contentDir, mdFile);

    // Ensure directory exists
    fs.mkdirSync(path.dirname(destFile), { recursive: true });

    // Copy file
    fs.copyFileSync(srcFile, destFile);

    // Extract first H1 for title
    const content = fs.readFileSync(srcFile, 'utf8');
    const h1Match = content.match(/^# (.+)$/m);
    const title = h1Match ? h1Match[1].trim() : mdFile.replace(/\.md$/, '');

    docs.push({
      file: mdFile,
      title,
      link: '/' + mdFile.replace(/\.md$/, '')
    });
  }

  // Sort with STRATEGY.md first
  docs.sort((a, b) => {
    if (a.file === 'STRATEGY.md') return -1;
    if (b.file === 'STRATEGY.md') return 1;
    return a.file.localeCompare(b.file);
  });

  // Write sidebar.json
  const sidebar = docs.map(doc => ({
    text: doc.title,
    link: doc.link
  }));

  fs.writeFileSync(
    path.join(contentDir, 'sidebar.json'),
    JSON.stringify(sidebar, null, 2)
  );

  // Write index.md
  const indexContent = `# Dev Pipeline Docs

${docs.map(doc => `- [${doc.title}](${doc.link})`).join('\n')}
`;

  fs.writeFileSync(path.join(contentDir, 'index.md'), indexContent);

  console.log(`Synced ${allMdFiles.length} markdown files to ${contentDir}`);
}

const args = process.argv.slice(2);
const watchMode = args.includes('--watch');

if (!watchMode) {
  performSync();
} else {
  performSync();

  let syncTimeout;
  const debounceSync = () => {
    clearTimeout(syncTimeout);
    syncTimeout = setTimeout(() => {
      performSync();
    }, 1000);
  };

  const topLevelWatchPath = srcRoot;
  const docsWatchPath = path.join(srcRoot, 'docs');

  try {
    const watcher1 = fs.watch(topLevelWatchPath, { recursive: false }, (eventType, filename) => {
      if (filename && filename.endsWith('.md')) {
        debounceSync();
      }
    });

    let watcher2;
    if (fs.existsSync(docsWatchPath)) {
      watcher2 = fs.watch(docsWatchPath, { recursive: true }, (eventType, filename) => {
        if (filename && filename.endsWith('.md')) {
          debounceSync();
        }
      });
    }

    process.on('SIGINT', () => {
      watcher1.close();
      if (watcher2) watcher2.close();
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      watcher1.close();
      if (watcher2) watcher2.close();
      process.exit(0);
    });
  } catch (err) {
    console.error('Watch setup failed:', err.message);
    process.exit(1);
  }
}
