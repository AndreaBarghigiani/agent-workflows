/**
 * Git runner matching the Python scripts' invocation:
 * `subprocess.run(['git', '-C', str(root), *args], capture_output=True,
 * text=True)`. Returns the exit status (`returncode`, negative on signals
 * like Python), stdout and stderr as strings; never throws on non-zero exit.
 */
import { spawnSync } from 'node:child_process';
import { constants as osConstants } from 'node:os';

export interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * `text=True` decodes with universal newlines: every `\r\n` and bare `\r`
 * becomes `\n` in the returned strings.
 */
function universalNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function runGit(root: string, args: string[]): GitResult {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  let status = result.status;
  if (status === null) {
    const signals = osConstants.signals as Record<string, number>;
    status = -(signals[result.signal ?? ''] ?? 0);
  }
  return {
    status,
    stdout: universalNewlines(result.stdout ?? ''),
    stderr: universalNewlines(result.stderr ?? ''),
  };
}
