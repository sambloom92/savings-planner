#!/usr/bin/env node
/**
 * Create the release tags (vX.Y.Z) on main. Run by the "Tag releases"
 * workflow on every push to main; safe to re-run — it only adds missing tags.
 *
 *   - releases.json lists past releases: each version with the commit that
 *     shipped it, or the pull request whose squash-merge commit ("… (#N)") did.
 *   - The version in package.json is tagged on the current commit if no tag
 *     of that name exists yet — so a merged PR that bumps the version is
 *     tagged without any other step.
 *
 *   node scripts/tag-releases.mjs            # create the missing tags locally
 *   node scripts/tag-releases.mjs --dry-run  # only list what would be tagged
 *
 * The workflow pushes the new tags afterwards (git push origin --tags).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const dryRun = process.argv.includes('--dry-run');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

const { releases } = readJson('../releases.json');
const { version } = readJson('../package.json');
const existing = new Set(git('tag', '--list', 'v*').split('\n').filter(Boolean));

// Main's history (first parent), newest first, as "sha subject".
const history = git('log', '--first-parent', '--format=%H %s', 'HEAD').split('\n');
const commitForPr = (n) => history.find((line) => line.endsWith(`(#${n})`))?.split(' ')[0];

const wanted = [];
for (const r of releases) {
  const sha = r.commit ? git('rev-parse', '--verify', `${r.commit}^{commit}`) : commitForPr(r.pr);
  if (!sha) {
    console.log(`v${r.version}: #${r.pr} isn't on this branch yet — skipped`);
    continue;
  }
  wanted.push({ tag: `v${r.version}`, sha, from: r.pr ? `#${r.pr}` : 'commit' });
}
// The current version, unless releases.json already places it (and its PR
// just isn't merged here yet).
if (!releases.some((r) => r.version === version))
  wanted.push({ tag: `v${version}`, sha: git('rev-parse', 'HEAD'), from: 'package.json' });

let created = 0;
for (const { tag, sha, from } of wanted) {
  if (existing.has(tag)) continue;
  if (dryRun) {
    console.log(`would tag ${tag} → ${sha.slice(0, 7)} (${from})`);
  } else {
    git('tag', '-a', tag, sha, '-m', `Savings Planner ${tag}`);
    console.log(`tagged ${tag} → ${sha.slice(0, 7)} (${from})`);
  }
  created++;
}
console.log(`${created} tag(s) ${dryRun ? 'to create' : 'created'}; ${existing.size} already existed.`);
