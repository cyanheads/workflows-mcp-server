/**
 * @fileoverview Domain types for the workflow index service.
 * @module services/workflow-index/types
 */

/** A single step in a workflow. */
export interface WorkflowStep {
  action?: string;
  description?: string;
  forEach?: string;
  name?: string;
  params?: Record<string, unknown>;
  server: string;
  tool: string;
}

/** A parsed, validated workflow document. */
export interface ParsedWorkflow {
  author: string;
  category?: string;
  created_date?: string;
  description: string;
  last_updated_date?: string;
  name: string;
  steps: WorkflowStep[];
  tags?: string[];
  temporary?: boolean;
  version: string;
}

/** An entry in the in-memory workflow index. */
export interface WorkflowEntry {
  filePath: string;
  isTemp: boolean;
  workflow: ParsedWorkflow;
}

/** The in-memory index keyed by "name@version". */
export type WorkflowIndex = Map<string, WorkflowEntry>;

/** Shape written to _index.json. */
export interface IndexSnapshot {
  count: number;
  entries: Record<
    string,
    {
      filePath: string;
      isTemp: boolean;
      name: string;
      version: string;
      category?: string;
      tags?: string[];
    }
  >;
  generatedAt: string;
}
