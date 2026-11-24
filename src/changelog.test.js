import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseChangelog, inlineTokens, compareVersions } from './changelog.js';

// ---------------------------------------------------------------------------
// Minimal test runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function it(label, fn) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${label}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

function describe(group, fn) {
  console.log(`\n${group}`);
  fn();
}

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

// ---------------------------------------------------------------------------

describe('parseChangelog', () => {
  const sample = [
    '# Changelog',
    '',
    'Intro text.',
    '',
    '## [1.1.0]',
    '',
    '### Added',
    '',
    '- A thing (#40):',
    '  - first part',
    '  - second part that',
    '    wraps',
    '',
    '## [1.0.0] — 2026-11-24',
    '',
    '### Fixed',
    '',
    '- A long fix that',
    '  wraps onto a second line (#39).',
  ].join('\n');
  const releases = parseChangelog(sample);

  it('reads releases newest first, with optional dates', () => {
    assert.deepEqual(
      releases.map((r) => [r.version, r.date]),
      [
        ['1.1.0', null],
        ['1.0.0', '2026-11-24'],
      ]
    );
  });

  it('reads sections, items, sub-items and wrapped lines', () => {
    assert.equal(releases[0].sections[0].title, 'Added');
    assert.deepEqual(releases[0].sections[0].items[0], {
      text: 'A thing (#40):',
      children: ['first part', 'second part that wraps'],
    });
    assert.equal(
      releases[1].sections[0].items[0].text,
      'A long fix that wraps onto a second line (#39).'
    );
  });
});

describe('inlineTokens', () => {
  it('splits bold, code, links and PR references', () => {
    assert.deepEqual(inlineTokens('**Major** — see `v1` at [semver](https://semver.org) (#12).'), [
      { type: 'bold', text: 'Major' },
      { type: 'text', text: ' — see ' },
      { type: 'code', text: 'v1' },
      { type: 'text', text: ' at ' },
      { type: 'link', text: 'semver', href: 'https://semver.org' },
      { type: 'text', text: ' (' },
      { type: 'pr', text: '#12', number: 12 },
      { type: 'text', text: ').' },
    ]);
  });

  it('plain text is one token', () => {
    assert.deepEqual(inlineTokens('Just words.'), [{ type: 'text', text: 'Just words.' }]);
  });
});

describe('compareVersions', () => {
  it('orders by major, minor, then patch — numerically', () => {
    assert.ok(compareVersions('0.10.0', '0.9.0') > 0);
    assert.ok(compareVersions('1.0.0', '0.27.2') > 0);
    assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  });
});

describe('CHANGELOG.md, package.json and releases.json agree', () => {
  const releases = parseChangelog(read('../CHANGELOG.md'));
  const { version } = JSON.parse(read('../package.json'));
  const past = JSON.parse(read('../releases.json')).releases;

  it('the newest changelog entry is the version in package.json', () => {
    assert.equal(releases[0].version, version);
  });

  it('versions are unique and run newest first', () => {
    for (let i = 1; i < releases.length; i++)
      assert.ok(
        compareVersions(releases[i - 1].version, releases[i].version) > 0,
        `${releases[i - 1].version} should be newer than ${releases[i].version}`
      );
  });

  it('every release has at least one item', () => {
    for (const r of releases)
      assert.ok(
        r.sections.some((s) => s.items.length > 0),
        `${r.version} has no items`
      );
  });

  it('every past release in releases.json has a changelog entry', () => {
    const inChangelog = new Set(releases.map((r) => r.version));
    for (const r of past) assert.ok(inChangelog.has(r.version), `${r.version} missing`);
  });

  it('each past release points at a commit or a pull request', () => {
    for (const r of past)
      assert.ok(
        /^[0-9a-f]{40}$/.test(r.commit ?? '') || Number.isInteger(r.pr),
        `${r.version} has no commit or PR`
      );
  });
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${'─'.repeat(50)}`);
if (failed === 0) {
  console.log(`All ${passed} tests passed.`);
} else {
  console.log(`${passed} passed, ${failed} failed.`);
  process.exitCode = 1;
}
