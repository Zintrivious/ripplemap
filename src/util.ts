/** 1-based line number of a character offset. */
export function lineAt(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content.charCodeAt(i) === 10) line++;
  }
  return line;
}

export function basename(file: string): string {
  return file.slice(file.lastIndexOf('/') + 1);
}

/** A link to one line of a file, in the URL style of the repo's host. */
export function fileUrl(repoUrl: string, file: string, line: number): string {
  if (/\/\/(dev\.azure\.com|[\w-]+\.visualstudio\.com)\//.test(repoUrl)) {
    return `${repoUrl}?path=/${encodeURI(file)}&line=${line}&lineEnd=${line}&lineStartColumn=1&lineEndColumn=1&lineStyle=plain&_a=contents`;
  }
  if (repoUrl.includes('//gitlab.com/')) return `${repoUrl}/-/blob/HEAD/${file}#L${line}`;
  if (repoUrl.includes('//bitbucket.org/')) return `${repoUrl}/src/HEAD/${file}#lines-${line}`;
  return `${repoUrl}/blob/HEAD/${file}#L${line}`;
}
