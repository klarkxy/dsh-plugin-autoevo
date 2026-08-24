import type { CreationGuard } from '../creation-guard.js'
import type { StateStore } from '../state/store.js'
import type { WorkflowHost } from './contracts.js'
import { WorkflowEngineResume } from './engine-resume.js'

export class WorkflowEngine extends WorkflowEngineResume {
  constructor(store: StateStore, creationGuard: CreationGuard, host: WorkflowHost) {
    super(store, creationGuard, host)
  }
}
