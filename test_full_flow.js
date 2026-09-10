import { putFile, getFile, updateRepoMetadata, ensureRepoMetadata } from './dist/utils/github.js';
import { execSync } from 'child_process';

const repo = 'wtf403/excalidrop-test-1789058749';
const homepage = `https://${repo.replace('/', '.github.io/')}/`;

console.log('1. Creating initial canvas file on main branch...');
const mainDoc = { type: 'excalidraw', version: 2, source: 'excalidrop', elements: [] };
const mainSha = await putFile(repo, 'canvas.excalidraw', mainDoc, 'Initial canvas', 'main');
console.log(`✓ Created on main: ${mainSha.slice(0, 7)}`);

console.log('\n2. Creating gh-pages branch and syncing canvas...');
const ghPagesSha = await putFile(repo, 'canvas.excalidraw', mainDoc, 'Initial viewer', 'gh-pages');
console.log(`✓ Created on gh-pages: ${ghPagesSha.slice(0, 7)}`);

console.log('\n3. Updating repository metadata...');
await ensureRepoMetadata(repo, homepage);
console.log('✓ Metadata updated');

console.log('\n4. Verifying metadata...');
const token = process.env.GITHUB_TOKEN || execSync('gh auth token', {encoding: 'utf8'}).trim();
const response = await fetch(`https://api.github.com/repos/${repo}`, {
  headers: { 
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json' 
  }
});
const data = await response.json();
console.log(`   description: ${data.description}`);
console.log(`   homepage: ${data.homepage}`);
console.log(`   has_pages: ${data.has_pages}`);

console.log('\n✅ Test complete!');
