// Shapes of the desk API as the UI uses them. Server rows carry more fields; the index signatures keep them reachable.
export interface Agent { id: string; name: string; role: string; bio?: string; short?: string; engine?: string; model?: string; effort?: string; enabled?: boolean; status?: string;
  current_ticket?: string | null; current_run?: number | null; current_kind?: string | null; meeting?: string | null; fallbacks?: Array<{ engine: string; model?: string; effort?: string }>; spend_today?: number; color?: string; [k: string]: unknown }
export interface Ticket { key: string; title: string; name?: string; description?: string; status: string; type?: string; priority?: string; priority_pinned?: number; done_at?: string | null; area?: string | null; complexity?: string | null;
  assignee?: string | null; reporter?: string; source?: string; parent_key?: string | null; branch?: string | null; pr_url?: string | null; head_sha?: string | null; active_run?: number | null;
  updated_at?: string; created_at?: string; progress_msg?: string | null; issue_number?: number | null; qa_loops?: number; research_review?: string | null; research_program?: string | null;
  research_generation?: number; after_key?: string | null; risk?: string | null; assign_pinned?: number; assign_reason?: string | null; [k: string]: unknown }
export interface Run { id: number; agent_id: string; kind: string; model?: string; status?: string; ticket_key?: string | null; reserve_usd?: number; cost_usd?: number; started_at?: string; [k: string]: unknown }
export interface DeskEvent { id: number; ts: string; kind: string; text: string; agent_id?: string | null; ticket_key?: string | null; run_id?: number | null; [k: string]: unknown }
export interface Comment { id: number; ticket_key: string; author: string; body: string; ts: string }
export interface BoardItem { id: string; key: string; name: string; bucket: string; kind?: string; stage?: string | null; verb?: string; reason?: string; action?: string; ticket?: Ticket;
  worker?: string | null; epic?: boolean; live?: boolean; proposal_id?: number; council_id?: number; incident?: { last_seen?: string; [k: string]: unknown }; code?: string;
  waiting?: { key: string; name: string; id: string }[] }
export interface Board { needs_you: BoardItem[]; decisions?: BoardItem[]; snoozed?: BoardItem[]; do_first?: string | null; blocked: BoardItem[]; working: BoardItem[]; queued: BoardItem[]; shipped: BoardItem[]; closed: BoardItem[]; epics: BoardItem[];
  counts: Record<string, number>; byKey: Record<string, BoardItem> }
export interface Program { id: string; label: string; seat: string; enabled: boolean; intervalMinutes: number; window: string; focus: string; sources: string[];
  tools: { web: boolean; connectors: string[] }; maxProposals: number; review: { minReviewers: number; reviewers: string[] };
  ok?: boolean; code?: string; reason?: string; last_run_at?: string | null; next_eligible_at?: string | null }
export interface Connector { name: string; status: string; purpose: string; case_md: string; binding: { type: string; url?: string; command?: string; args?: string[] } | null; tools: string[];
  proposed_by: string; assessed_by?: string | null; assessment?: { verdict: string; benefit_score: number; sdlc_stage: string; risk: string; rationale: string; cost_estimate: string; time_estimate: string; data_leaving: string; conditions: string[] } | null;
  approved_at?: string | null; review_after?: string | null; decision_note?: string | null; due_for_review?: boolean; usage?: { runs: number; cost_usd: number; proposals: number; passed_review: number; last_used_at: string | null } }

/* eslint-disable @typescript-eslint/no-explicit-any */
/** The store (ui/src/store.js). Server-shaped parts stay loose: they mirror /api/state as delivered. */
export interface DeskState {
  agents: Agent[]; tickets: Ticket[]; events: DeskEvent[]; runs: Run[]; incidents: any[];
  settings: Record<string, string>; meta: Record<string, any>;
  connected: boolean; loadError: string | null; loaded: boolean;
  view: string; palette: boolean; feature: string | null; featureDetail: { key: string; data: any; error: string | null; seq: number } | null;
  sheet: { type: string; key?: string; id?: string; number?: number; decision?: string | null; focus?: boolean; tab?: string; nonce?: number; banner?: any } & Record<string, any> | null;
  detail: { key: string; data: any; pending: any; error: string | null; seq: number } | null;
  seat: { id: string; events: any[] | null; stats: any } | null;
  questions: Record<string, any>; prs: any; prsAt: number; prsLoading: boolean; councils: Record<number, any>;
  research: any; open: Record<string, boolean>; seen: Set<string>; painted: boolean; drafts: Record<string, string>;
}

export interface PlanTask { ref: string; title: string; area: string; complexity: 'S' | 'M'; risk: 'low' | 'high'; after: string | null; description: string; acceptance: string[] }
export interface FeaturePlanBody { summary: string; goal: string; users: string[]; scope: string[]; out_of_scope: string[]; acceptance: string[]; risks: string[]; questions: string[]; tasks: PlanTask[] }
export interface FeaturePlan { ticket_key: string; revision: number; status: 'queued' | 'grooming' | 'ready' | 'failed' | 'approved' | 'discarded'; engine: string; direction?: string;
  plan: FeaturePlanBody | null; error?: string | null; run_id?: number | null; model?: string | null; stale?: boolean; attempts?: number; created_at?: string; updated_at?: string;
  approved_at?: string; approved_tasks?: string[]; task_keys?: Record<string, string> }
