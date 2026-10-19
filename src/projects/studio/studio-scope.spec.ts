import { studioProgress } from '../project-progress';
import { commitStage, createEmptyProject } from './studio-graph';
import {
  allowedStages,
  applyScopeRules,
  chooseEntry,
  downstreamOf,
  FULL_SCOPE,
  lockAfterRun,
  nextSteps,
  parseScope,
  scopeOf,
  visibleStages,
} from './studio-scope';
import {
  parseStudioProject,
  readStudioMeta,
  studioMetaOf,
} from './studio-persistence';

describe('entry-step scope', () => {
  it('treats projects without a scope as full projects', () => {
    expect(scopeOf(createEmptyProject())).toEqual(FULL_SCOPE);
  });

  it('follows data flow, not tab order, for what comes after a step', () => {
    expect(downstreamOf('magnetics')).toEqual([
      'thermal',
      'mtbf',
      'bom',
      'components',
    ]);
    // Device selection lives on the simulation: no Devices step.
    expect(downstreamOf('simulation')).toEqual([
      'magnetics',
      'thermal',
      'mtbf',
      'bom',
      'emc',
      'components',
    ]);
    expect(downstreamOf('mtbf')).toEqual([]);
    expect(downstreamOf('specs')).toHaveLength(9);
  });

  it('allows the entry step and everything after it, nothing before', () => {
    const scope = {
      mode: 'entry' as const,
      entry: 'thermal' as const,
      locked: false,
    };
    expect(allowedStages(scope)).toEqual(['thermal', 'mtbf', 'bom']);
    expect(allowedStages({ mode: 'undecided' })).toEqual([]);
  });

  it('shows the entry step plus later steps with results', () => {
    const scope = {
      mode: 'entry' as const,
      entry: 'magnetics' as const,
      locked: true,
    };
    expect(visibleStages(scope, () => false)).toEqual(['magnetics']);
    expect(visibleStages(scope, (s) => s === 'thermal')).toEqual([
      'magnetics',
      'thermal',
    ]);
    expect(visibleStages(FULL_SCOPE, () => false)).toHaveLength(8);
    expect(visibleStages(FULL_SCOPE, (s) => s === 'emc')).toContain('emc');
    expect(visibleStages({ mode: 'undecided' }, () => true)).toEqual([]);
  });

  it('offers the direct successors of ready steps', () => {
    const scope = {
      mode: 'entry' as const,
      entry: 'magnetics' as const,
      locked: true,
    };
    expect(nextSteps(scope, (s) => s === 'magnetics')).toEqual([
      'thermal',
      'mtbf',
      'bom',
      'components',
    ]);
    expect(nextSteps(scope, () => false)).toEqual([]);
  });

  it('lets the entry step change until it runs, then locks it', () => {
    const chosen = chooseEntry({ mode: 'undecided' }, 'simulation');
    expect(chosen).toEqual({
      ok: true,
      scope: { mode: 'entry', entry: 'simulation', locked: false },
    });
    if (!chosen.ok) throw new Error('unreachable');
    const moved = chooseEntry(chosen.scope, 'design');
    expect(moved.ok && moved.scope).toMatchObject({ entry: 'design' });

    const locked = lockAfterRun(chosen.scope, 'simulation');
    expect(locked).toMatchObject({ locked: true });
    expect(chooseEntry(locked, 'design').ok).toBe(false);
    expect(chooseEntry(locked, 'simulation').ok).toBe(true);
    // A tool of an earlier stage (input capture) does not lock.
    expect(lockAfterRun(chosen.scope, 'visualization')).toBe(chosen.scope);
  });

  it('enforces forward-only and locks on every graph write', () => {
    const before = createEmptyProject(undefined, {
      mode: 'entry',
      entry: 'design',
      locked: false,
    });
    // Recording the topology (an input of Design) neither fails nor locks.
    const topology = commitStage(before, 'visualization', {}).project;
    const recorded = applyScopeRules(before, topology);
    expect(recorded.ok && recorded.project.scope).toMatchObject({
      locked: false,
    });
    // The first Design result locks the entry step.
    const designed = commitStage(topology, 'design', {}).project;
    const locked = applyScopeRules(topology, designed);
    expect(locked.ok && locked.project.scope).toMatchObject({ locked: true });

    const thermal = createEmptyProject(undefined, {
      mode: 'entry',
      entry: 'thermal',
      locked: true,
    });
    const upstream = applyScopeRules(
      thermal,
      commitStage(thermal, 'simulation', {}).project,
    );
    expect(upstream).toEqual({ ok: false, stage: 'simulation' });
    // With no step chosen, the first result makes it a full design.
    const undecided = createEmptyProject(undefined, { mode: 'undecided' });
    const started = applyScopeRules(
      undecided,
      commitStage(undecided, 'specs', {}).project,
    );
    expect(started.ok && started.project.scope).toEqual(FULL_SCOPE);
    // Full projects are never restricted.
    const full = createEmptyProject();
    expect(
      applyScopeRules(full, commitStage(full, 'mtbf', {}).project).ok,
    ).toBe(true);
  });

  it('locks a full project at once', () => {
    const chosen = chooseEntry({ mode: 'undecided' }, 'specs');
    expect(chosen.ok && chosen.scope).toEqual(FULL_SCOPE);
  });

  it('round-trips through the stored Studio meta', () => {
    const project = createEmptyProject('Size an inductor', {
      mode: 'entry',
      entry: 'magnetics',
      locked: false,
    });
    const meta = readStudioMeta({ studio: studioMetaOf(project) });
    expect(meta.scope).toEqual(project.scope);
    expect(parseStudioProject(project).scope).toEqual(project.scope);
    expect(parseScope({ mode: 'entry', entry: 'nope' })).toBeNull();
    expect(parseScope({ mode: 'undecided' })).toEqual({ mode: 'undecided' });
  });

  it('counts progress over the stages the project shows', () => {
    let project = createEmptyProject(undefined, {
      mode: 'entry',
      entry: 'magnetics',
      locked: true,
    });
    expect(studioProgress(project)).toEqual({ completed: 0, total: 1 });
    project = commitStage(project, 'magnetics', {}).project;
    expect(studioProgress(project)).toEqual({ completed: 1, total: 1 });
    expect(
      studioProgress(createEmptyProject(undefined, { mode: 'undecided' })),
    ).toEqual({ completed: 0, total: 1 });
  });
});
