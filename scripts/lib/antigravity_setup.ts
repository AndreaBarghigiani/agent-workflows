import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const ANTIGRAVITY_SETUP = '.agents/antigravity-mcp.json';
export const ANTIGRAVITY_DESTINATION = '.agents/mcp_config.json';

/** Install/update advisory. The setup command validates prerequisites and conflicts. */
export function antigravitySetupNotice(root: string): string | null {
  if (existsSync(join(root, ANTIGRAVITY_DESTINATION))) return null;
  if (existsSync(join(root, ANTIGRAVITY_SETUP))) {
    return 'Antigravity project registration is missing; run the opted-in setup_antigravity_mcp command.';
  }
  try {
    const declaration = JSON.parse(
      readFileSync(join(root, '.agents/mcp-requirements.json'), 'utf8'),
    );
    if (declaration?.version === 1 && Array.isArray(declaration.services) &&
        declaration.services.length > 0) {
      return 'MCP services are declared, but .agents/mcp_config.json is absent. For Antigravity worktrees, see the opt-in setup in docs/t3-checkout-readiness.md.';
    }
  } catch {
    // An absent or invalid declaration provides no indication of project intent.
  }
  return null;
}
