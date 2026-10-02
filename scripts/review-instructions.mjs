/** H13: only execution-folder/ancestor instructions configure this reviewer. */
import fs from 'node:fs';
import path from 'node:path';
import { git, hash } from './git.mjs';
import { boundedBytes } from './baseline-bytes.mjs';

function observe(cwd, { maxEntries = 4096, maxBytes = 8 * 1024 * 1024, maxFileBytes = 1024 * 1024, requireGit = false } = {}) {
  const execution = fs.realpathSync(cwd);
  const repository = git(cwd, ['rev-parse', '--show-toplevel'], true);
  let entries = 0;
  if (repository.status !== 0) {
    if (requireGit) throw Error('Recorded Git repository is unavailable for instruction checks.');
    if (repository.error || !/^fatal: not a git repository \(or any of the parent directories\): \.git\s*$/i.test(repository.stderr.trim()))
      throw Error('Cannot determine instruction root: ' + (repository.error?.message || repository.stderr).slice(0, 2000));
    // The same Git error also describes damaged repositories. Only marker-free
    // folders may fall back; lstat retains dangling links and fails on denied reads.
    for (let folder = execution;; folder = path.dirname(folder)) {
      if (++entries > maxEntries) throw Error('Instruction inventory exceeds entry limit: ' + maxEntries);
      const marker = path.join(folder, '.git');
      let stat;
      try { stat = fs.lstatSync(marker); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (stat) throw Error('Git metadata marker exists but repository discovery failed: ' + marker);
      if (path.dirname(folder) === folder) break;
    }
  }
  const root = repository.status === 0 ? fs.realpathSync(repository.stdout.trim()) : execution;
  const relative = path.relative(root, execution);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw Error('Reviewer execution folder is outside the Git root.');
  const files = {}, folders = []; let bytes = 0;
  function inspect(file, directoryAllowed = false, depth = 0) {
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (++entries > maxEntries) throw Error('Instruction inventory exceeds entry limit: ' + maxEntries);
    if (stat.isSymbolicLink()) throw Error('Linked instruction paths are not supported: ' + file);
    if (stat.isDirectory() && directoryAllowed) {
      if (depth > 64) throw Error('Instruction inventory exceeds directory depth limit.');
      const directory = fs.opendirSync(file);
      try { let entry; while ((entry = directory.readSync())) inspect(path.join(file,entry.name),true,depth+1); }
      finally { directory.closeSync(); }
      return;
    }
    if (!stat.isFile()) throw Error('Expected a regular instruction file: ' + file);
    if (stat.size > maxBytes - bytes) throw Error('Instruction inventory exceeds byte limit: ' + maxBytes);
    const content = boundedBytes(file,Math.min(maxFileBytes,maxBytes-bytes)); bytes += content.length;
    files[path.relative(root,file).replaceAll('\\','/')] = hash(content);
  }
  for (let folder = execution;; folder = path.dirname(folder)) {
    folders.push(path.relative(root,folder).replaceAll('\\','/'));
    inspect(path.join(folder,'AGENTS.md')); inspect(path.join(folder,'AGENTS.override.md'));
    inspect(path.join(folder,'.codex'),true);
    if (folder.toLowerCase() === root.toLowerCase()) break;
  }
  return { files: Object.fromEntries(Object.entries(files).sort(([a],[b])=>a<b?-1:a>b?1:0)), folders };
}
export function instructionSnapshot(cwd, limits) { return observe(cwd,limits).files; }
export function assertReviewInstructions(state) {
  const requireGit = state.baseline?.available === true || state.attemptBaseline?.available === true;
  const {files:current,folders} = observe(state.executionCwd, { requireGit });
  // Old rows lack ignored content: preserve their conservative known-file fallback.
  const relevant = file => folders.some(folder => {
    const prefix = folder ? folder + '/' : '', local = file.slice(prefix.length);
    return file.startsWith(prefix) && /^(?:AGENTS(?:\.override)?\.md$|\.codex(?:\/|$))/i.test(local);
  });
  const baseline = state.reviewInstructionBaseline ?? Object.fromEntries(Object.entries(state.baseline?.files || {}).filter(([file,v])=>relevant(file) && v).map(([file,v])=>[file,v.hash]));
  const changed = [...new Set([...Object.keys(baseline),...Object.keys(current)])].filter(file=>relevant(file) && baseline[file] !== current[file]);
  if (changed.length) throw Error('Project instructions/configuration changed; reviewer configuration cannot be reliably disabled. Paths: ' + changed.join(', '));
}
