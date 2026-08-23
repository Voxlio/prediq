/* =============================================================================
   tools/io.mjs — the file-backed side of store.js.

   store.js defines the archive's layout and knows nothing about how it is
   stored; this supplies { read, write, list } over a directory on disk, for the
   scheduled writer. The browser never loads this file.

   Kept deliberately thin. Anything that reasons about records belongs in
   store.js or record.js so that the writer and the site cannot come to
   different conclusions about the same archive.
   ========================================================================== */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* PREDIQ_ROOT redirects the whole archive somewhere else. The workflow never
   sets it; it exists so the writers can be run end to end against a scratch
   directory — by the test suite, and by anyone who wants to see what a run would
   do without touching the committed archive. A --dry-run tells you what a script
   intends; this lets you inspect what it actually produces. */
export const DEFAULT_ROOT = process.env.PREDIQ_ROOT
  ? resolve(process.env.PREDIQ_ROOT)
  : ROOT;

/* --- reporting back to the workflow ----------------------------------------
   GitHub Actions reads step outputs from the file named by $GITHUB_OUTPUT. Both
   writers call this so the commit subject can say what actually changed instead
   of the workflow grepping the diff for it — a grep that would silently start
   counting the wrong lines the first time the record schema gained a field.

   Absent outside Actions, in which case this does nothing.
--------------------------------------------------------------------------- */
export function report(values) {
  const path = process.env.GITHUB_OUTPUT;
  if (!path) return;
  appendFileSync(path, Object.entries(values).map(([k, v]) => k + '=' + v).join('\n') + '\n');
}

export function fileIO(root = DEFAULT_ROOT) {
  return {
    root,

    /* A missing file is a normal answer, not a failure — most days have no
       archive entry. Anything else is rethrown, because a permissions error or
       malformed JSON must stop the run rather than be mistaken for an empty
       archive and quietly overwritten. */
    async read(path) {
      try {
        return JSON.parse(await readFile(join(root, path), 'utf8'));
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw new Error('cannot read ' + path + ': ' + err.message);
      }
    },

    async write(path, text) {
      const full = join(root, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, text, 'utf8');
      return path;
    },

    /* Day keys present in the archive, derived from the filenames themselves.
       Not from index.json: the index is something this writer produces, and a
       lister that trusted it could not rebuild it after it went wrong. */
    async list() {
      try {
        return (await readdir(join(root, 'data')))
          .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
          .map(f => f.slice(0, 10))
          .sort();
      } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
      }
    },
  };
}
