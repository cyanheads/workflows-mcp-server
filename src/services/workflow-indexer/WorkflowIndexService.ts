/**
 * @fileoverview Manages an in-memory index of all available workflows.
 * It uses a directory watcher to automatically keep the index up-to-date
 * as workflow YAML files are added, changed, or removed.
 * @module src/services/workflow-indexer/WorkflowIndexService
 */

import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";
import chokidar, { FSWatcher } from "chokidar";
import yaml from "js-yaml";
import semver from "semver";
import { logger, type RequestContext } from "../../utils/index.js";
import { requestContextService } from "../../utils/internal/requestContext.js";

// --- Type Definitions ---

export interface WorkflowStep {
  server: string;
  tool: string;
  action: string;
  params: Record<string, unknown>;
  description?: string;
}

export interface Workflow {
  name: string;
  version: string;
  description: string;
  author: string;
  created_date: string;
  last_updated_date: string;
  category: string;
  tags: string[];
  steps: WorkflowStep[];
  temporary?: boolean;
}

export type WorkflowMetadata = Workflow & { filePath: string };

// --- Service Implementation ---

class WorkflowIndexService {
  private static instance: WorkflowIndexService;
  private isInitialized = false;
  private index: Map<string, WorkflowMetadata> = new Map();
  private tempIndex: Map<string, WorkflowMetadata> = new Map();
  private watcher?: FSWatcher;

  private readonly WORKFLOWS_BASE_DIR: string;
  private readonly CATEGORIES_DIR: string;

  private constructor() {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    this.WORKFLOWS_BASE_DIR = path.resolve(
      __dirname,
      "../../../workflows-yaml",
    );
    this.CATEGORIES_DIR = path.join(this.WORKFLOWS_BASE_DIR, "categories");
  }

  public static getInstance(): WorkflowIndexService {
    if (!WorkflowIndexService.instance) {
      WorkflowIndexService.instance = new WorkflowIndexService();
    }
    return WorkflowIndexService.instance;
  }

  public async initialize(context: RequestContext): Promise<void> {
    if (this.isInitialized) {
      logger.warning("WorkflowIndexService already initialized.", context);
      return;
    }
    logger.info("Initializing WorkflowIndexService...", context);
    await this.buildIndex(
      requestContextService.createRequestContext({
        parentContext: context,
        operation: "InitialIndexBuild",
      }),
    );
    this.setupWatcher(
      requestContextService.createRequestContext({
        parentContext: context,
        operation: "SetupWatcher",
      }),
    );
    this.isInitialized = true;
    logger.info(
      `WorkflowIndexService initialized. Watching for changes in: ${this.CATEGORIES_DIR}`,
      context,
    );
  }

  public async buildIndex(context: RequestContext): Promise<void> {
    logger.info("Building workflow index from scratch...", context);
    const newIndex = new Map<string, WorkflowMetadata>();
    const newTempIndex = new Map<string, WorkflowMetadata>();
    try {
      const categories = await fs.readdir(this.CATEGORIES_DIR, {
        withFileTypes: true,
      });
      for (const category of categories) {
        if (category.isDirectory()) {
          const categoryPath = path.join(this.CATEGORIES_DIR, category.name);
          const files = await fs.readdir(categoryPath);
          const yamlFiles = files.filter(
            (file) => file.endsWith(".yaml") || file.endsWith(".yml"),
          );

          for (const file of yamlFiles) {
            const filePath = path.join(categoryPath, file);
            try {
              const fileContent = await fs.readFile(filePath, "utf-8");
              const doc = yaml.load(fileContent) as Workflow;
              // Basic validation
              if (doc && doc.name && doc.version) {
                const relativePath = path.relative(
                  this.WORKFLOWS_BASE_DIR,
                  filePath,
                );
                const workflowMeta = { ...doc, filePath: relativePath };
                const key = `${doc.name}@${doc.version}`;

                if (doc.temporary) {
                  newTempIndex.set(key, workflowMeta);
                } else {
                  newIndex.set(key, workflowMeta);
                }
              } else {
                logger.warning(
                  `Skipping invalid workflow file (missing name or version): ${filePath}`,
                  context,
                );
              }
            } catch (e) {
              logger.error(
                `Error parsing workflow file, skipping: ${filePath}`,
                e as Error,
                context,
              );
            }
          }
        }
      }
      this.index = newIndex;
      this.tempIndex = newTempIndex;
      logger.info(
        `Workflow index build complete. Found ${this.index.size} public and ${this.tempIndex.size} temporary workflow versions.`,
        context,
      );

      // Persist the index to a file
      try {
        const indexFilePath = path.join(this.WORKFLOWS_BASE_DIR, "_index.json");
        const indexData = Array.from(this.index.values());
        await fs.writeFile(
          indexFilePath,
          JSON.stringify(indexData, null, 2),
          "utf-8",
        );
        logger.info(
          `Successfully saved workflow index to: ${indexFilePath}`,
          context,
        );
      } catch (writeError) {
        logger.error(
          "Failed to write workflow index to file.",
          writeError as Error,
          context,
        );
      }
    } catch (error) {
      logger.error("Failed to build workflow index.", error as Error, context);
      // Depending on requirements, we might want to throw here to halt startup
    }
  }

  private setupWatcher(context: RequestContext): void {
    this.watcher = chokidar.watch(this.CATEGORIES_DIR, {
      ignored: /(^|[\/\\])\../, // ignore dotfiles
      persistent: true,
      ignoreInitial: true,
      depth: 99, // watch subdirectories
    });

    const debounceRebuild = this.debounce(() => {
      const rebuildContext = requestContextService.createRequestContext({
        parentContext: context,
        operation: "DebouncedRebuild",
      });
      logger.info(
        "Change detected, rebuilding workflow index.",
        rebuildContext,
      );
      this.buildIndex(rebuildContext);
    }, 500);

    this.watcher
      .on("add", (path: string) => {
        logger.debug(`File added: ${path}. Triggering rebuild.`, context);
        debounceRebuild();
      })
      .on("change", (path: string) => {
        logger.debug(`File changed: ${path}. Triggering rebuild.`, context);
        debounceRebuild();
      })
      .on("unlink", (path: string) => {
        logger.debug(`File removed: ${path}. Triggering rebuild.`, context);
        debounceRebuild();
      })
      .on("error", (error: unknown) => {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error("Watcher error:", err, context);
      });
  }

  private debounce(func: (...args: any[]) => void, delay: number) {
    let timeout: NodeJS.Timeout;
    return (...args: any[]) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => func(...args), delay);
    };
  }

  public getAllWorkflows(context: RequestContext): WorkflowMetadata[] {
    logger.debug(
      `Retrieving all ${this.index.size} workflows from index.`,
      context,
    );
    return Array.from(this.index.values());
  }

  public findWorkflow(
    name: string,
    version?: string,
    context?: RequestContext,
  ): WorkflowMetadata | undefined {
    const key = version ? `${name}@${version}` : null;

    // Search public index first
    if (key) {
      const publicResult = this.index.get(key);
      if (publicResult) {
        logger.debug(
          `Found public workflow by name and version: ${key}`,
          context,
        );
        return publicResult;
      }
    }

    // If not found or no version specified, search for latest public version
    const publicVersions = Array.from(this.index.values())
      .filter((w) => w.name === name)
      .sort((a, b) => semver.rcompare(a.version, b.version));

    if (publicVersions.length > 0 && !version) {
      logger.debug(
        `Found latest public version of workflow: ${name}@${publicVersions[0].version}`,
        context,
      );
      return publicVersions[0];
    }

    // If still not found, check the temporary index
    if (key) {
      const tempResult = this.tempIndex.get(key);
      if (tempResult) {
        logger.debug(
          `Found temporary workflow by name and version: ${key}`,
          context,
        );
        return tempResult;
      }
    }

    const tempVersions = Array.from(this.tempIndex.values())
      .filter((w) => w.name === name)
      .sort((a, b) => semver.rcompare(a.version, b.version));

    if (tempVersions.length > 0 && !version) {
      logger.debug(
        `Found latest temporary version of workflow: ${name}@${tempVersions[0].version}`,
        context,
      );
      return tempVersions[0];
    }

    logger.debug(
      `Workflow not found in any index: ${name}${version ? "@" + version : ""}`,
      context,
    );
    return undefined;
  }

  public async stopWatcher(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
    }
  }
}

export const workflowIndexService = WorkflowIndexService.getInstance();
