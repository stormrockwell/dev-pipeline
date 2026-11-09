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
  title: 'Dev Pipeline Docs',
  cleanUrls: true,
  themeConfig: {
    outline: [2, 3],
    outlineTitle: 'On this page',
    search: {
      provider: 'local'
    },
    sidebar
  }
};
