import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findProductPathsInMainignore, globToRegExp, parseMainignore, PRODUCT_PATHS, readmeImages } from '../../scripts/lib/check-helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SYNC = path.join(ROOT, 'scripts/sync-main.sh');

test('parseMainignore strips comments, whitespace and blank lines (like sync-main.sh)', () => {
  const text = '# header\n\nCLAUDE.md\n  dev  \ntests # trailing comment\n\t\r\nstore-assets/src\r\n#scripts\n';
  assert.deepEqual(parseMainignore(text), [
    { line: 3, pattern: 'CLAUDE.md' },
    { line: 4, pattern: 'dev' },
    { line: 5, pattern: 'tests' },
    { line: 7, pattern: 'store-assets/src' },
  ]);
});

test('globToRegExp follows bash globbing (no globstar, * stays inside one segment)', () => {
  assert.ok(globToRegExp('docs/*.md').test('docs/ALGORITHM.md'));
  assert.ok(!globToRegExp('docs/*.md').test('docs/sub/x.md'));
  assert.ok(globToRegExp('*.md').test('README.md'));
  assert.ok(!globToRegExp('*.md').test('docs/PRIVACY.md'));
  assert.ok(globToRegExp('dev/').test('dev'));
  assert.ok(globToRegExp('demo?.html').test('demo2.html'));
  assert.ok(globToRegExp('[a-c]x').test('bx'));
  assert.ok(globToRegExp('[!a-c]x').test('dx'));
  assert.ok(!globToRegExp('[!a-c]x').test('ax'));
  assert.ok(globToRegExp('a.b').test('a.b') && !globToRegExp('a.b').test('aXb'));
});

test('findProductPathsInMainignore catches product paths, their parents and globs that match them', () => {
  const entries = parseMainignore(['tests', 'docs/ARCHITECTURE.md', 'docs', '*.md', 'extension/src/content', 'LICENSE', '.github', '.github/workflows', './README.md', 'store-assets/src'].join('\n'));
  const bad = findProductPathsInMainignore(entries);
  assert.deepEqual(
    bad.map((b) => [b.pattern, b.product]),
    [
      ['docs', 'docs/PRIVACY.md'],
      ['*.md', 'README.md'],
      ['extension/src/content', 'extension/'],
      ['LICENSE', 'LICENSE'],
      ['.github', '.github/ISSUE_TEMPLATE'],
      ['./README.md', 'README.md'],
    ],
  );
  // README images are product paths too
  const imgs = readmeImages('![shot](store-assets/screenshots/01.png) <img src="./extension/icons/logo.svg"> ![](https://x/y.png)');
  assert.deepEqual(imgs, ['store-assets/screenshots/01.png', 'extension/icons/logo.svg']);
  assert.deepEqual(
    findProductPathsInMainignore(parseMainignore('store-assets/screenshots'), [...PRODUCT_PATHS, ...imgs]).map((b) => b.product),
    ['store-assets/screenshots/01.png'],
  );
});

test("the repo's .mainignore lists no product path and keeps the dev-only folders off main", () => {
  const entries = parseMainignore(readFileSync(path.join(ROOT, '.mainignore'), 'utf8'));
  const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.deepEqual(findProductPathsInMainignore(entries, [...PRODUCT_PATHS, ...readmeImages(readme)]), []);
  const patterns = entries.map((e) => e.pattern);
  for (const p of ['dev', 'tests', 'scripts', 'CLAUDE.md', '.mainignore', 'package.json', 'i18n']) assert.ok(patterns.includes(p), p);
});

// ───────────── scripts/sync-main.sh, end to end, in a throw-away repository ─────────────

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv(cwd) }).trim();
}
function gitEnv(cwd) {
  // Isolated from the user's git config (signing, hooks, default branch …).
  const empty = path.join(path.dirname(cwd), 'empty.gitconfig');
  writeFileSync(empty, '');
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: empty,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
}
function sync(cwd, ...args) {
  return execFileSync('bash', [SYNC, ...args], { cwd, encoding: 'utf8', env: gitEnv(cwd), stdio: ['ignore', 'pipe', 'pipe'] });
}
function makeRepo() {
  const base = mkdtempSync(path.join(os.tmpdir(), 'transprice-sync-'));
  const repo = path.join(base, 'repo');
  mkdirSync(repo);
  const files = {
    'extension/manifest.json': '{}',
    'extension/src/content/content.js': '// product',
    'README.md': '# TransPrice',
    'LICENSE': 'MIT',
    'CHANGELOG.md': '# Changelog',
    'docs/PRIVACY.md': 'privacy',
    'docs/ARCHITECTURE.md': 'guide',
    'dev/demo.html': '<p>demo</p>',
    'tests/a.test.mjs': '',
    'scripts/x.mjs': '',
    'store-assets/src/icon.svg': '<svg/>',
    'store-assets/logo-512.png': 'png',
    'CLAUDE.md': 'notes',
    '.github/workflows/ci.yml': 'ci',
    '.github/ISSUE_TEMPLATE/bug.yml': 'bug',
    '.gitignore': 'dist/\n*.zip\n',
    'notes-1.tmp.md': 'glob me',
    'notes-2.tmp.md': 'glob me',
    '.mainignore': '# dev-only\nCLAUDE.md\n.mainignore\ndocs/ARCHITECTURE.md\ndev\ntests # trailing comment\nscripts\n.github/workflows\nstore-assets/src\nnotes-*.tmp.md\n',
  };
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    writeFileSync(path.join(repo, f), c);
  }
  git(repo, 'init', '-q', '-b', 'dev');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'Initial commit', '-m', 'Co-Authored-By: Someone <s@example.com>');
  return { base, repo };
}

test('sync-main.sh without origin: builds local main from dev minus .mainignore, then reports "already in sync"', () => {
  const { base, repo } = makeRepo();
  try {
    const out1 = sync(repo);
    assert.match(out1, /No 'origin' remote/);
    assert.match(out1, /dev@\w+ → main@\w+/);
    assert.match(out1, /git remote add origin https:\/\/github\.com\/PhamTienThanhCong\/TransPriceExtension\.git/);
    const tree = git(repo, 'ls-tree', '-r', '--name-only', 'main').split('\n').sort();
    assert.deepEqual(tree, [
      '.github/ISSUE_TEMPLATE/bug.yml',
      '.gitignore',
      'CHANGELOG.md',
      'LICENSE',
      'README.md',
      'docs/PRIVACY.md',
      'extension/manifest.json',
      'extension/src/content/content.js',
      'store-assets/logo-512.png',
    ]);
    assert.equal(git(repo, 'branch', '--show-current'), 'dev', 'stays on dev');
    assert.equal(git(repo, 'status', '--porcelain'), '', 'working tree untouched');
    const msg = git(repo, 'log', '-1', '--format=%B', 'main');
    assert.match(msg, /^Sync from dev@\w+: Initial commit/);
    assert.match(msg, /Co-Authored-By: Someone <s@example.com>/);

    const out2 = sync(repo);
    assert.match(out2, /main is already in sync with dev@/);
    assert.equal(git(repo, 'rev-list', '--count', 'main'), '1');

    // A new dev commit → exactly one more main commit, on top of the previous one.
    writeFileSync(path.join(repo, 'README.md'), '# TransPrice v2');
    writeFileSync(path.join(repo, 'dev/demo.html'), 'changed demo');
    git(repo, 'commit', '-qam', 'Update README');
    sync(repo);
    assert.equal(git(repo, 'rev-list', '--count', 'main'), '2');
    assert.equal(git(repo, 'show', 'main:README.md'), '# TransPrice v2');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('sync-main.sh with origin: pushes dev and main; refuses dirty trees, other branches and product paths in .mainignore', () => {
  const { base, repo } = makeRepo();
  try {
    const remote = path.join(base, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', remote], { env: gitEnv(repo) });
    git(repo, 'remote', 'add', 'origin', remote);
    const out = sync(repo);
    assert.match(out, /Pushing dev/);
    assert.match(out, /Pushing main/);
    assert.equal(git(remote, 'rev-parse', 'main'), git(repo, 'rev-parse', 'main'));
    assert.equal(git(remote, 'rev-parse', 'dev'), git(repo, 'rev-parse', 'dev'));
    assert.match(sync(repo), /already in sync[\s\S]*origin\/main is up to date/);
    assert.match(sync(repo, '--local'), /--local/);

    writeFileSync(path.join(repo, 'README.md'), 'dirty');
    assert.throws(() => sync(repo), /Uncommitted changes/);
    git(repo, 'checkout', '-q', '--', 'README.md');

    git(repo, 'switch', '-q', '-c', 'feature');
    assert.throws(() => sync(repo), /Run this from the dev branch/);
    git(repo, 'switch', '-q', 'dev');

    writeFileSync(path.join(repo, '.mainignore'), 'extension\n');
    git(repo, 'commit', '-qam', 'Oops');
    assert.throws(() => sync(repo, '--local'), /extension\/manifest\.json would be missing from main/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
