import type {
  EvalMetadata,
  EvalProduct,
  EvalStage,
  EvalSuite,
} from '@hookdeck-evals/core/eval-metadata';

export type {
  ScoreResult,
  CheckResult,
  ToolCallRecord,
  TranscriptPart,
  TranscriptSerializationOptions,
  JudgeInput,
  JudgeResult,
  CommandResult,
  SkillResult,
  DocsResult,
  VitestResult,
  ToolEvalContext,
  ToolScorer,
  ExperimentConfig,
} from '@hookdeck-evals/core';
export { judge, serializeTranscript } from '@hookdeck-evals/core';
export type {
  EvalInterface,
  EvalMetadata,
  EvalProduct,
  EvalStage,
  EvalSuite,
  ExperimentSuite,
} from '@hookdeck-evals/core/eval-metadata';

export type EvalMode = 'tools' | 'local-stack';

export interface EvalManifest {
  id: string;
  mode: EvalMode;
  metadata: EvalMetadata;
  stage: EvalStage;
  product: EvalProduct[];
  suite: EvalSuite;
  topic: string[];
  dir: string;
  /**
   * `local/` — the agent's starting files (the developer's working
   * directory). Project evals copy it to the host workspace the agent edits;
   * local-stack evals copy it into the sandbox.
   */
  localDir?: string;
  promptPath: string;
  evalPath: string;
  /**
   * `remote/` — the hosted project's starting state, seeded into
   * platform-lite (project.sql, logs.jsonl, functions/).
   */
  remoteDir: string;
}
