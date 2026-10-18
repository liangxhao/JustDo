import fs from 'node:fs/promises';
import path from 'node:path';

export interface QuestionUploadFile {
  name: string;
  mimeType: string;
  content: string;
  relativePath?: string;
}
const mimeTypes: Record<string, string> = {
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.svg': 'image/svg+xml',
  '.stl': 'model/stl',
};
const within = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

/** Only pass paths returned by the native chooser, never renderer-provided paths. */
export async function readQuestionUploadFiles(paths: string[]): Promise<QuestionUploadFile[]> {
  const files: QuestionUploadFile[] = [];
  let bytes = 0;
  let entries = 0;
  const read = async (
    file: string,
    root?: { selected: string; real: string },
    depth = 0,
  ): Promise<void> => {
    if (++entries > 1024 || depth > 8 || files.length >= 64)
      throw new Error('Upload selection is too large');
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) throw new Error('Upload selection includes a filesystem link');
    const resolved = await fs.realpath(file);
    if (root && !within(root.real, resolved))
      throw new Error('Upload escaped the selected directory');
    if (stat.isDirectory()) {
      const identity = await fs.stat(resolved);
      if (identity.ino !== stat.ino || identity.dev !== stat.dev)
        throw new Error('Upload directory changed');
      const approved = root ?? { selected: file, real: resolved };
      for (const child of await fs.readdir(file))
        await read(path.join(file, child), approved, depth + 1);
      if ((await fs.realpath(file)) !== resolved) throw new Error('Upload directory changed');
    } else if (stat.isFile()) {
      if ((bytes += stat.size) > 5 * 1024 * 1024)
        throw new Error('Upload exceeds the native 5 MiB limit');
      const handle = await fs.open(resolved, 'r');
      let content: Buffer;
      try {
        const before = await handle.stat();
        if (
          !before.isFile() ||
          before.size !== stat.size ||
          before.ino !== stat.ino ||
          before.dev !== stat.dev
        )
          throw new Error('Upload selection changed');
        content = await handle.readFile();
        const after = await handle.stat();
        if (
          content.byteLength !== stat.size ||
          before.mtimeMs !== after.mtimeMs ||
          (await fs.realpath(file)) !== resolved
        )
          throw new Error('Upload file changed during reading');
        if (root && (await fs.realpath(root.selected)) !== root.real)
          throw new Error('Upload root changed');
      } finally {
        await handle.close();
      }
      files.push({
        name: path.basename(file),
        mimeType: mimeTypes[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        content: content.toString('base64'),
        ...(root
          ? { relativePath: path.relative(root.selected, file).split(path.sep).join('/') }
          : {}),
      });
    } else throw new Error('Upload selection is not a regular file or directory');
  };
  for (const file of paths) await read(file);
  return files;
}
