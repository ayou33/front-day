import type { Dispatch, Project, Resource, Stage } from './contracts.ts'

export function usesProjectFiles(project: Project, task: Pick<Dispatch, 'apiFiles'>) {
  return project.apiFiles !== false && task.apiFiles !== false
}

export function applyApiRestrictions<T extends { project: Project; resources: Resource[]; apiFiles?: boolean }>(
  snapshot: T, currentProject: Project | undefined, currentResources: Resource[],
): T {
  const modes = new Map(currentResources.filter(item => item.projectId === snapshot.project.id).map(item => [item.id, item.apiShare]))
  return { ...snapshot, apiFiles: currentProject?.apiFiles === false ? false : snapshot.apiFiles, resources: snapshot.resources.map(item => {
    const mode = modes.get(item.id)
    return item.apiShare === 'excluded' || !mode || mode === 'auto' ? item : { ...item, apiShare: mode }
  }) }
}

export function sharing(resource: Resource, task: Pick<Dispatch, 'apiExcluded'>, stage?: Pick<Stage, 'resourceIds' | 'allResources'>) {
  if (resource.apiShare === 'excluded' || task.apiExcluded?.includes(resource.id)
    || (stage && !stage.allResources && !stage.resourceIds.includes(resource.id))) return 'excluded'
  if (resource.apiShare === 'on-demand' || resource.kind === 'file') return 'on-demand'
  return 'auto'
}

export function resourceConflicts(resources: Resource[]) {
  const project = new Map(resources.filter(item => !item.iterationId).map(item => [resourceKey(item), item]))
  return new Set(resources.flatMap(item => {
    const inherited = item.iterationId && project.get(resourceKey(item))
    return inherited && (inherited.kind !== item.kind || inherited.value !== item.value || inherited.prompt !== item.prompt)
      ? [item.id, inherited.id] : []
  }))
}

function resourceKey(resource: Resource) {
  return `${resource.category.trim().toLowerCase()}\n${resource.name.trim().toLowerCase()}`
}
