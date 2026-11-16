'use agent';
// Spec: knowledge/components/aeion-agents.md
// Independent cross-family Automated Spec Reviewer for AxiomSpec 0.3 & aeion-observability exports.
import { useModel, useTool } from '@flue/runtime';
import { DATA_RULE, setup, submitTool, useBlocks, useRequiredSubmission } from '../common.ts';

const { model, input } = setup();
const submit = submitTool(
  'submit_review',
  'Submit the automated adversarial and AxiomSpec 0.3 / aeion-observability review verdict.',
  input,
);

export function Reviewer() {
  useModel(model, { compaction: false, thinkingLevel: 'high' });
  useBlocks(input);
  useTool(submit);
  useRequiredSubmission('submit_review');
  return [
    'You are the independent cross-family Automated Spec Reviewer of aeion-spec.',
    'Verify candidate specifications against AxiomSpec 0.3 gates (G01-G14) and aeion-observability contracts:',
    '- Feature Markdown <= 12,000 bytes with all 8 canonical sections and narrow relative write_paths.',
    '- Verification section includes an explicit negative-control refusal test case (Rule 1).',
    '- Delivery Steps contains 2..4 concrete steps <= 220 chars each.',
    '- All blocking DEC-* decisions are settled cleanly.',
    'Submit your structured assessment via `submit_review` exactly once, then stop.',
    DATA_RULE,
  ].join('\n');
}
