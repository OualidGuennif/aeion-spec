// Spec: knowledge/components/aeion-agents.md

import * as v from 'valibot';
import { bridgeTool } from '../common.ts';

export const listSandboxFiles = bridgeTool(
  'list_sandbox_files',
  'List read-only quarantined file paths inside the project OpenShell snapshot. Never grants write or host access.',
  v.object({
    prefix: v.optional(v.string()),
  }),
);

export const readSandboxSlice = bridgeTool(
  'read_sandbox_slice',
  'Read a bounded line slice (<= 120 lines) from one quarantined OpenShell file with O_NOFOLLOW protection.',
  v.object({
    path: v.string(),
    startLine: v.optional(v.number()),
    endLine: v.optional(v.number()),
  }),
);

export const searchSandboxFiles = bridgeTool(
  'search_sandbox_files',
  'Search bounded substring matches across quarantined OpenShell source files.',
  v.object({
    query: v.string(),
  }),
);
