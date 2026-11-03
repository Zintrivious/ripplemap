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
