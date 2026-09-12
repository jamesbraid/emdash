import { inArray } from 'drizzle-orm';
import type { AppDb, DrizzleTx } from '@core/services/app-db/node/db';
import { projects, tasks } from '@core/services/app-db/node/schema';

export type WorkspaceAnnotationIndex = {
  taskWorkspaceIds: Set<string>;
  projectRepositoryWorkspaceIds: Set<string>;
};

/** The desktop-owned annotation links for a set of mirror rows (task + project-repo). */
export function loadWorkspaceAnnotations(
  db: AppDb | DrizzleTx,
  workspaceIds: string[]
): WorkspaceAnnotationIndex {
  if (workspaceIds.length === 0) {
    return {
      taskWorkspaceIds: new Set<string>(),
      projectRepositoryWorkspaceIds: new Set<string>(),
    };
  }
  const taskRows = db
    .select({ workspaceId: tasks.workspaceId })
    .from(tasks)
    .where(inArray(tasks.workspaceId, workspaceIds))
    .all();
  const projectRows = db
    .select({ workspaceId: projects.repositoryWorkspaceId })
    .from(projects)
    .where(inArray(projects.repositoryWorkspaceId, workspaceIds))
    .all();
  return {
    taskWorkspaceIds: new Set(
      taskRows.flatMap((row) => (row.workspaceId ? [row.workspaceId] : []))
    ),
    projectRepositoryWorkspaceIds: new Set(
      projectRows.flatMap((row) => (row.workspaceId ? [row.workspaceId] : []))
    ),
  };
}

export type AffectedWorkspaceRows = {
  workspaceIds: ReadonlySet<string>;
  /** Parent repository ids of those rows: a repository's children list under its project. */
  parentIds: ReadonlySet<string>;
};

/**
 * Every project whose views include one of these rows: projects with a task on the
 * row, and projects whose repository workspace is the row or its parent (the
 * workspace groups read lists a repository's children as candidates).
 */
export function loadWorkspaceProjectIds(
  db: AppDb | DrizzleTx,
  rows: AffectedWorkspaceRows
): Set<string> {
  const projectIds = new Set<string>();
  if (rows.workspaceIds.size > 0) {
    const taskRows = db
      .select({ projectId: tasks.projectId })
      .from(tasks)
      .where(inArray(tasks.workspaceId, [...rows.workspaceIds]))
      .all();
    for (const row of taskRows) projectIds.add(row.projectId);
  }
  const repositoryIds = [...new Set([...rows.workspaceIds, ...rows.parentIds])];
  if (repositoryIds.length > 0) {
    const projectRows = db
      .select({ id: projects.id })
      .from(projects)
      .where(inArray(projects.repositoryWorkspaceId, repositoryIds))
      .all();
    for (const row of projectRows) projectIds.add(row.id);
  }
  return projectIds;
}
