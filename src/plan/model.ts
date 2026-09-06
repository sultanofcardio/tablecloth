// The query plan shape every dialect's EXPLAIN output is folded into, shared
// by the host (parsers, runner) and the panel webview (the Plan tab). No
// vscode imports here.
import type { DriverId } from '../core/types';

export interface PlanNode {
  /** The operation: "Hash Join", "Seq Scan", "Nested loop", "SEARCH". */
  op: string;
  /** What it works on, dimmed after the op: relation and alias, condition, filter … */
  detail: string;
  /** Planner estimate of the total cost, in the dialect's units. */
  cost?: number;
  startupCost?: number;
  /** Planner estimate of the rows this node produces. */
  rows?: number;
  /** Rows the node really produced (Explain Analyse), summed over its loops. */
  actualRows?: number;
  /** Time the node took including its children, in milliseconds, summed over its loops. */
  timeMs?: number;
  loops?: number;
  children: PlanNode[];
  /** Everything else the planner said about the node, for the table view. */
  props: [string, string][];
}

export interface QueryPlan {
  dialect: DriverId;
  /** The statement was executed and the nodes carry runtime figures. */
  analysed: boolean;
  roots: PlanNode[];
  /** Whole-statement runtime figures, in milliseconds (Explain Analyse). */
  executionMs?: number;
  planningMs?: number;
  /** The plan as the server returned it (JSON or text). Host-side only. */
  raw: string;
}

/** A plan as the panel sees it: the server document stays on the host. */
export type PanelPlan = Omit<QueryPlan, 'raw'>;

export function panelPlan(plan: QueryPlan): PanelPlan {
  return {
    dialect: plan.dialect,
    analysed: plan.analysed,
    roots: plan.roots,
    executionMs: plan.executionMs,
    planningMs: plan.planningMs,
  };
}

/** Walk the nodes depth first. */
export function* planNodes(nodes: PlanNode[]): Generator<PlanNode> {
  for (const node of nodes) {
    yield node;
    yield* planNodes(node.children);
  }
}

/** The number of nodes in the plan. */
export function planSize(plan: QueryPlan): number {
  return [...planNodes(plan.roots)].length;
}
