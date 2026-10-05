import { failure, type ArtifactRef, type Failure, type OutputSpec } from '../contracts.js';
import { NULL_SHA } from './artifacts.js';

export function declaredOutputFailure(outputs: readonly OutputSpec[] | undefined, publication: {
  missing: readonly string[];
  artifacts: readonly ArtifactRef[];
  commit: string;
  failed: boolean;
}): Failure | undefined {
  if (!outputs?.length) return undefined;
  if (publication.missing.length > 0) return failure('ARTIFACTS_MISSING', 'finalization', 'One or more declared output files are missing or unsafe');
  if (publication.failed || publication.commit === NULL_SHA || !/^[a-f0-9]{40}$/i.test(publication.commit)) {
    return failure('ARTIFACT_PUBLICATION_FAILED', 'finalization', 'Declared outputs have no confirmed publication commit');
  }
  if (outputs.some((output) => !publication.artifacts.some((artifact) => artifact.path === `artifacts/${output.path}`))) {
    return failure('ARTIFACTS_MISSING', 'finalization', 'One or more declared output files were not published');
  }
  return undefined;
}

export function buildAgentPrompt(prompt: string, outputs: readonly OutputSpec[] | undefined): string {
  if (!outputs?.length) return prompt;
  return `${prompt}\n\nHost output requirements:\nCreate every declared output as a regular file relative to the current working directory: ${JSON.stringify(outputs.map((output) => output.path))}. Execute the task, not just a plan. Write the final user-facing answer to .agent/answer.txt. Declared outputs must exist for the run to succeed.`;
}
