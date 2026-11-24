/**
 * Reads CHANGELOG.md (Keep a Changelog style) for the in-app "What's new"
 * panel: releases as `## [x.y.z] — date` headings (the date is optional, for
 * an unreleased version), sections as `### Added` etc., and items as `- …`
 * bullets, with `  - …` sub-bullets and wrapped lines continuing an item.
 */

/**
 * @param {string} markdown
 * @returns {Array<{ version: string, date: string|null,
 *   sections: Array<{ title: string, items: Array<{ text: string, children: string[] }> }> }>}
 */
export function parseChangelog(markdown) {
  const releases = [];
  let release = null;
  let section = null;
  for (const raw of markdown.split('\n')) {
    const line = raw.trimEnd();
    const heading = line.match(/^## \[(\d+\.\d+\.\d+)\](?:\s+[—–-]\s+(.+))?$/);
    if (heading) {
      release = { version: heading[1], date: heading[2] ?? null, sections: [] };
      releases.push(release);
      section = null;
      continue;
    }
    if (!release) continue;
    const sub = line.match(/^### (.+)$/);
    if (sub) {
      section = { title: sub[1], items: [] };
      release.sections.push(section);
      continue;
    }
    if (!section) continue;
    const item = line.match(/^- (.+)$/);
    if (item) {
      section.items.push({ text: item[1], children: [] });
      continue;
    }
    const last = section.items.at(-1);
    if (!last) continue;
    const child = line.match(/^ {2}- (.+)$/);
    if (child) {
      last.children.push(child[1]);
      continue;
    }
    const wrapped = line.match(/^\s{2,}(\S.*)$/);
    if (wrapped) {
      if (last.children.length > 0) last.children[last.children.length - 1] += ` ${wrapped[1]}`;
      else last.text += ` ${wrapped[1]}`;
    }
  }
  return releases;
}

/**
 * Split a line of changelog text into plain text, **bold**, `code`,
 * [links](url) and pull request references like (#39) / #39.
 *
 * @param {string} text
 * @returns {Array<{ type: 'text'|'bold'|'code'|'link'|'pr', text: string, href?: string, number?: number }>}
 */
export function inlineTokens(text) {
  const tokens = [];
  const pattern = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|#(\d+)\b/g;
  let at = 0;
  for (const m of text.matchAll(pattern)) {
    if (m.index > at) tokens.push({ type: 'text', text: text.slice(at, m.index) });
    if (m[1] !== undefined) tokens.push({ type: 'bold', text: m[1] });
    else if (m[2] !== undefined) tokens.push({ type: 'code', text: m[2] });
    else if (m[3] !== undefined) tokens.push({ type: 'link', text: m[3], href: m[4] });
    else tokens.push({ type: 'pr', text: `#${m[5]}`, number: Number(m[5]) });
    at = m.index + m[0].length;
  }
  if (at < text.length) tokens.push({ type: 'text', text: text.slice(at) });
  return tokens;
}

/** Compare two x.y.z versions: negative if a is older than b. */
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}
