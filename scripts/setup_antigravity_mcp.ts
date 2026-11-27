import { join, resolve } from 'node:path';
import { antigravityWorktreeConfig } from './mcp_configure.ts';
import { ANTIGRAVITY_DESTINATION } from './lib/antigravity_setup.ts';
import { atomicWrite } from './lib/atomic.ts';

const usage = 'usage: agent-workflows setup_antigravity_mcp --project PROJECT [--check]';

export function main(argv: string[]): number {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    console.log(usage);
    return 0;
  }
  const [flag, project, check, ...extra] = argv;
  if (flag !== '--project' || !project || project.startsWith('-') ||
      (check !== undefined && check !== '--check') || extra.length > 0) {
    console.error(usage);
    return 2;
  }
  try {
    const root = resolve(project);
    const output = antigravityWorktreeConfig(root);
    if (output === null) return 0;
    if (check === '--check') {
      console.error('Antigravity project registration is missing; rerun without --check to create it.');
      return 1;
    }
    atomicWrite(join(root, ANTIGRAVITY_DESTINATION), output, { createOnly: true });
    console.log('Created .agents/mcp_config.json; runtime MCP connectivity is unverified.');
    return 0;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    console.error(error.name === 'ValueError' ? error.message :
      'Could not prepare Antigravity project registration; check project files and retry.');
    return 1;
  }
}
