// The Team overview's view of the live store. Every number comes from public/departments.js over the same snapshot +
// stream the rest of the desk reads; counts are partitions of the attention board, so they agree with Inbox and Work.
import { departmentsFor, departmentCounts, departmentKpis, seatStates, flowsFrom, departmentFlows, exceptions } from '../../../../public/departments.js';
import { S, currentBoard, openTicket, openFeature, openSheet, setView } from '@/store.js';
import type { Agent, Board, BoardItem } from '@/types';

export type Department = ReturnType<typeof departmentsFor>[number];
export type SeatState = ReturnType<typeof seatStates>[string];
export type Kpi = ReturnType<typeof departmentKpis>['release'][number];
export type DeptFlow = ReturnType<typeof departmentFlows>[number];
export type Exception = ReturnType<typeof exceptions>[number];
export interface TeamOverview {
  deps: Department[]; agents: Record<string, Agent>; states: Record<string, SeatState>;
  counts: Record<string, { working: number; queued: number; blocked: number; waiting: BoardItem[] }>;
  kpis: Record<string, { concern: string; kpis: Kpi[] }>; release: Kpi[]; flows: DeptFlow[]; exceptions: Exception[]; board: Board; now: number;
}

export function teamOverview(now = Date.now()): TeamOverview {
  const agents = S.agents as Agent[];
  const deps = departmentsFor(agents, S.settings.team_departments || null);
  const waiting = [...(S.meta.scheduler?.waiting || []), ...(S.meta.scheduler?.mention_queue || [])];
  const states = seatStates({ agents, runs: S.runs, events: S.events, waiting, now });
  const board = currentBoard() as Board;
  const { departments, release } = departmentKpis(S, deps, { now, board });
  return {
    deps, agents: Object.fromEntries(agents.map((a) => [a.id, a])), states, board, now, kpis: departments, release,
    counts: departmentCounts(board, deps) as TeamOverview['counts'],
    flows: departmentFlows(flowsFrom({ events: S.events, agents, tickets: S.tickets, now }), deps),
    exceptions: exceptions({ board, states, agents, incidents: S.incidents, now }),
  };
}

/** Open a waiting decision where the Inbox would: the Decision sheet, a feature plan, the access panel, or the Inbox. */
export function openDecision(it: BoardItem & { access?: unknown }) {
  if (it.kind === 'plan' && it.ticket) return openFeature(it.ticket.key);
  if (it.kind === 'access') return openSheet({ type: 'access' });
  if (it.ticket) return openTicket(it.ticket.key, { decision: it.id });
  return setView('inbox');
}

export const STATE_TEXT: Record<string, string> = { working: 'working', quiet: 'working quietly', stalled: 'no update for a while', next: 'up next', idle: 'available', off: 'switched off' };
