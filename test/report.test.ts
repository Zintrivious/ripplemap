import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { renderReport, reportData } from '../src/report.ts';
import { scan } from '../src/scan.ts';

const fixture = fileURLToPath(new URL('./fixtures/acme', import.meta.url));
const { graph } = scan(fixture, { owner: 'acme' });
graph.source = 'test/fixtures/acme';

const embedded = (html: string) => {
  const json = /<script type="application\/json" id="ripplemap-data">(.*?)<\/script>/s.exec(html)?.[1];
  assert.ok(json, 'data script tag is present');
  return JSON.parse(json) as ReturnType<typeof reportData>;
};

test('report embeds the graph, drift and repo owner', () => {
  const html = renderReport(graph);
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>ripplemap · test\/fixtures\/acme<\/title>/);

  const data = embedded(html);
  assert.equal(data.owner, 'acme');
  assert.equal(data.repos.length, 7);
  assert.equal(data.links.length, graph.links.length);
  assert.ok(data.links.some((l) => l.from === 'acme/frontend' && l.to === 'acme/api' && l.file === 'docker-compose.yml'));
  assert.deepEqual(data.drift[0]?.versions.map((v) => v.version), ['^2.1.0', '^1.9.0']);
});

test('report is self-contained', () => {
  const html = renderReport(graph);
  assert.doesNotMatch(html, /<script[^>]+src=/);
  assert.doesNotMatch(html, /<link[^>]+stylesheet/);
  assert.doesNotMatch(html, /https?:\/\/(?!github\.com|gitlab\.com|bitbucket\.org|www\.w3\.org)[\w.-]+\//);
});

test('values from scanned files cannot break out of the page', () => {
  const hostile = structuredClone(graph);
  hostile.source = '<img src=x onerror=alert(1)>';
  hostile.links[0]!.name = '</script><script>alert(1)</script>';
  const html = renderReport(hostile);
  assert.doesNotMatch(html, /<\/script><script>alert/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.equal(embedded(html).links[0]!.name, '</script><script>alert(1)</script>');
});

test('an incomplete scan shows a notice in the report', () => {
  assert.doesNotMatch(renderReport(graph), /Incomplete scan/);
  const incomplete = { ...graph, warnings: [{ repo: 'acme/api', file: 'Dockerfile', message: 'could not read' }] };
  assert.match(renderReport(incomplete), /<b>Incomplete scan.<\/b> 1 file or repo could not be read/);
});
