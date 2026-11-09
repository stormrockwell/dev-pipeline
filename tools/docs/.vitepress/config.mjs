import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const contentDir = path.join(__dirname, '../content');
const sidebarPath = path.join(contentDir, 'sidebar.json');

let sidebar = [];
if (fs.existsSync(sidebarPath)) {
  sidebar = JSON.parse(fs.readFileSync(sidebarPath, 'utf8'));
}

export default {
  srcDir: 'content',
  // GitHub Pages serves the site under the repo name, so the deploy workflow sets DOCS_BASE.
  base: process.env.DOCS_BASE || '/',
  title: 'Dev Pipeline Docs',
  cleanUrls: true,
  markdown: {
    config(md) {
      // Docs quote template syntax such as `{{` in inline code, which Vue would otherwise try to compile.
      const codeInline = md.renderer.rules.code_inline;
      md.renderer.rules.code_inline = (...args) => codeInline(...args).replace('<code', '<code v-pre');
    }
  },
  themeConfig: {
    outline: [2, 3],
    outlineTitle: 'On this page',
    search: {
      provider: 'local'
    },
    sidebar
  }
};
