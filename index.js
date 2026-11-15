/**
 * Agent-callable bridge to the DeepSeek Harness Web GUI's own operations.
 *
 * Every tool here calls the same Host service the browser calls, so a session,
 * workspace, permission mode, setting, or plugin row created by the agent is
 * the one the GUI renders and persists.
 *
 * @module @local/dsh-gui-bridge
 */

import { mkdirSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

export const name = 'dsh-gui-bridge'
export const inject = ['tools']

const SANDBOX_RANK = { 'read-only': 0, 'workspace-write': 1, 'danger-full-access': 2 }
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function resolveOptions(config) {
  const source = config ?? {}
  const configured = Number.isInteger(source.maxItems) && source.maxItems > 0
    ? Math.min(source.maxItems, MAX_LIMIT)
    : DEFAULT_LIMIT
  return {
    modeWidening: source.modeWidening === 'allow',
    sessionPrompt: source.sessionPrompt !== false,
    marketToggle: source.marketToggle !== false,
    maxItems: configured,
    language: typeof source.language === 'string' && source.language.trim() !== ''
      ? source.language.trim()
      : 'en',
  }
}

function describeError(error) {
  if (error !== null && typeof error === 'object') {
    const code = typeof error.code === 'string' ? `${error.code}: ` : ''
    const message = typeof error.message === 'string' ? error.message : String(error)
    return `${code}${message}`
  }
  return String(error)
}

async function call(label, run) {
  try {
    return await run()
  } catch (error) {
    throw new Error(`${label} failed: ${describeError(error)}`)
  }
}

function service(ctx, key) {
  const value = ctx.get(key)
  if (value === undefined) {
    throw new Error(`this profile does not load the ${key} service, so this action is unavailable here`)
  }
  return value
}

function bounded(items, limit) {
  return {
    items: items.slice(0, limit),
    total: items.length,
    truncated: items.length > limit,
  }
}

function limitOf(value, fallback) {
  if (!Number.isInteger(value) || value <= 0) return fallback
  return Math.min(value, MAX_LIMIT)
}

function render(_args, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
}

const OUTPUT = { schema: { type: 'object', additionalProperties: true }, render }

const SESSION_ID = {
  type: 'string',
  description: 'Session id. Omit to target the calling session.',
}

const LIMIT = {
  type: 'integer',
  description: 'Maximum rows to return. Defaults to the plugin\'s maxItems (50).',
}

function callingSessionId(args, exec) {
  if (typeof args.session_id === 'string' && args.session_id !== '') return args.session_id
  const fallback = exec.agent === undefined ? undefined : exec.agent.id
  if (typeof fallback !== 'string' || fallback === '') {
    throw new Error('session_id is required: this call has no calling session to default to')
  }
  return fallback
}

/** The live Agent for a Session, resuming a cold one when needed. */
async function agentOf(ctx, sessionId) {
  const live = service(ctx, 'agents').get(sessionId)
  if (live !== undefined) return live
  const controller = service(ctx, 'sessionController')
  const resolved = await call(`resuming session ${sessionId}`, () => controller.resolveAgent(sessionId))
  if (resolved.error !== undefined) throw new Error(`session ${sessionId} is unavailable: ${describeError(resolved.error)}`)
  return resolved.agent
}

/** The Session record for a Session id, resuming a cold one when needed. */
async function sessionOf(ctx, sessionId) {
  const sessions = service(ctx, 'sessions')
  const direct = sessions.get(sessionId)
  if (direct !== undefined) return direct
  await agentOf(ctx, sessionId)
  const resumed = sessions.get(sessionId)
  if (resumed === undefined) throw new Error(`session ${sessionId} could not be opened`)
  return resumed
}

function sessionRow(summary) {
  const row = {
    session_id: summary.sessionId,
    running: summary.running,
    blank: summary.blank,
    agent_available: summary.agentAvailable,
    updated_at: new Date(summary.updatedAt).toISOString(),
  }
  if (typeof summary.cwd === 'string') row.cwd = summary.cwd
  if (typeof summary.parentSessionId === 'string') row.parent_session_id = summary.parentSessionId
  if (typeof summary.origin === 'string') row.origin = summary.origin
  const title = summary.projections === undefined ? undefined : summary.projections.values?.title
  if (typeof title === 'string') row.title = title
  else if (title !== null && typeof title === 'object' && typeof title.title === 'string') row.title = title.title
  return row
}

/* ------------------------------------------------------------------ */
/* dsh_gui_session                                                     */
/* ------------------------------------------------------------------ */

function sessionTool(ctx, options) {
  return {
    name: 'dsh_gui_session',
    description:
      'Operate DeepSeek Harness sessions exactly as the GUI sidebar does: list them, create one (optionally in a workspace, '
      + 'directory, and agent preset), read live state, rename, fork, archive, pin, deliver a message, or cancel the running turn. '
      + 'A created session is persisted and appears in the GUI at once. Omitting session_id targets the calling session.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          description: 'Operation to perform.',
          enum: ['list', 'create', 'state', 'rename', 'fork', 'archive', 'unarchive', 'pin', 'unpin', 'prompt', 'cancel'],
        },
        session_id: SESSION_ID,
        title: { type: 'string', description: 'Session title, for `rename`; optional for `create`.' },
        workspace_id: { type: 'string', description: 'Workspace to place a new session in, for `create`.' },
        cwd: { type: 'string', description: 'Working directory for a new session, for `create`.' },
        agent_preset: { type: 'string', description: 'Agent preset id for a new session, for `create`.' },
        text: { type: 'string', description: 'Message text to deliver, for `prompt`.' },
        delivery: {
          type: 'string',
          enum: ['queue', 'steer'],
          description: 'How `prompt` is delivered: queue after the running turn, or steer into it. Defaults to `queue`.',
        },
        at_seq: { type: 'integer', description: 'Last event sequence to include, for `fork`. Defaults to the latest completed turn.' },
        allow_migration: { type: 'boolean', description: 'For `fork`: accept a format migration preflight instead of refusing.' },
        stop_activity: { type: 'boolean', description: 'For `archive`: stop running work instead of refusing while it runs.' },
        limit: LIMIT,
      },
      required: ['action'],
    },
    output: OUTPUT,
    async execute(args, exec) {
      const controller = service(ctx, 'sessionController')
      switch (args.action) {
        case 'list': {
          const value = await call('listing sessions', () => controller.list({}, exec.signal))
          const page = bounded(value.items, limitOf(args.limit, options.maxItems))
          return { sessions: page.items.map(sessionRow), total: page.total, truncated: page.truncated }
        }
        case 'create': {
          const request = {}
          if (typeof args.workspace_id === 'string' && args.workspace_id !== '') request.workspaceId = args.workspace_id
          if (typeof args.cwd === 'string' && args.cwd !== '') request.cwd = args.cwd
          if (typeof args.agent_preset === 'string' && args.agent_preset !== '') request.agentPreset = args.agent_preset
          const created = await call('creating a session', () => controller.create(request))
          const result = { session_id: created.sessionId }
          if (created.agentPreset !== undefined) result.agent_preset = created.agentPreset
          if (typeof args.title === 'string' && args.title !== '') {
            const renamed = await call('titling the new session', () => controller.rename({ sessionId: created.sessionId, title: args.title }))
            result.title = renamed.title
          }
          return result
        }
        case 'state': {
          const sessionId = callingSessionId(args, exec)
          const state = await call(`reading session ${sessionId}`, () => controller.state({ sessionId }, exec.signal))
          return {
            session_id: sessionId,
            active: state.active,
            running: state.running,
            queue: state.queue === null ? null : state.queue.length,
            pending_input: state.pendingInput,
            cursor: state.cursor,
          }
        }
        case 'rename': {
          const sessionId = callingSessionId(args, exec)
          if (typeof args.title !== 'string' || args.title.trim() === '') throw new Error('title is required for `rename`')
          const renamed = await call(`renaming session ${sessionId}`, () => controller.rename({ sessionId, title: args.title }))
          return { session_id: sessionId, title: renamed.title, seq: renamed.seq }
        }
        case 'fork': {
          const sessionId = callingSessionId(args, exec)
          const request = { sessionId }
          if (Number.isInteger(args.at_seq)) request.atSeq = args.at_seq
          if (args.allow_migration === true) request.allowMigration = true
          const forked = await call(`forking session ${sessionId}`, () => controller.fork(request))
          return { session_id: forked.sessionId, forked_from: sessionId }
        }
        case 'archive': {
          const sessionId = callingSessionId(args, exec)
          const request = { sessionId }
          if (args.stop_activity === true) request.stopActivity = true
          const value = await call(`archiving session ${sessionId}`, () => service(ctx, 'workspaceController').archiveSession(request))
          return { session_id: sessionId, archived_count: value.archivedSessionIds.length }
        }
        case 'unarchive': {
          const sessionId = callingSessionId(args, exec)
          const value = await call(`unarchiving session ${sessionId}`, () => service(ctx, 'workspaceController').unarchiveSession({ sessionId }))
          return { session_id: sessionId, archived_count: value.archivedSessionIds.length }
        }
        case 'pin': {
          const sessionId = callingSessionId(args, exec)
          const value = await call(`pinning session ${sessionId}`, () => service(ctx, 'workspaceController').pinSession({ sessionId }))
          return { session_id: sessionId, pinned: value.pinnedSessionIds }
        }
        case 'unpin': {
          const sessionId = callingSessionId(args, exec)
          const value = await call(`unpinning session ${sessionId}`, () => service(ctx, 'workspaceController').unpinSession({ sessionId }))
          return { session_id: sessionId, pinned: value.pinnedSessionIds }
        }
        case 'prompt': {
          if (!options.sessionPrompt) throw new Error('delivering messages from this tool is turned off by the plugin\'s sessionPrompt setting')
          if (typeof args.text !== 'string' || args.text.trim() === '') throw new Error('text is required for `prompt`')
          const sessionId = callingSessionId(args, exec)
          const request = {
            requestId: randomUUID(),
            sessionId,
            mode: args.delivery === 'steer' ? 'steer' : 'queue',
            content: [{ type: 'text', text: args.text }],
          }
          const accepted = await call(`delivering a message to session ${sessionId}`, () => controller.prompt(request, exec.signal))
          return { session_id: sessionId, accepted: accepted.accepted, delivery: request.mode }
        }
        case 'cancel': {
          const sessionId = callingSessionId(args, exec)
          const value = await call(`cancelling session ${sessionId}`, () => controller.cancel({ sessionId }))
          return { session_id: sessionId, accepted: value.accepted }
        }
        default:
          throw new Error(`unknown action: ${String(args.action)}`)
      }
    },
  }
}

/* ------------------------------------------------------------------ */
/* dsh_gui_workspace                                                   */
/* ------------------------------------------------------------------ */

function workspaceRow(workspace) {
  // The registry returns Workspace (id); the controller returns WorkspaceView (workspaceId).
  const id = workspace.id ?? workspace.workspaceId
  return {
    workspace_id: id,
    title: workspace.title,
    path: workspace.path,
    session_count: workspace.sessionIds.length,
    session_ids: workspace.sessionIds.slice(0, 20),
  }
}

function ensureDirectory(path) {
  let stats
  try {
    stats = statSync(path)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    mkdirSync(path, { recursive: true })
    return
  }
  if (!stats.isDirectory()) throw new Error(`${path} exists but is not a directory`)
}

function workspaceTool(ctx, options) {
  return {
    name: 'dsh_gui_workspace',
    description:
      'Manage DeepSeek Harness workspaces and their session grouping: list registered workspaces, register a directory as a workspace '
      + '(creating the directory when asked), rename, remove the registration, reorder, or move one session within a workspace. '
      + 'Workspaces are the folders the GUI sidebar groups conversations under.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          description: 'Operation to perform.',
          enum: ['list', 'create', 'rename', 'delete', 'reorder', 'move_session'],
        },
        workspace_id: { type: 'string', description: 'Workspace id, required except for `list` and `create`.' },
        path: { type: 'string', description: 'Absolute existing directory to register, for `create`.' },
        title: { type: 'string', description: 'Display title, for `rename`, or applied to a newly created workspace.' },
        before_workspace_id: { type: 'string', description: 'For `reorder`: place the workspace before this one; omit to append.' },
        session_id: { type: 'string', description: 'Session to move, for `move_session`.' },
        before_session_id: { type: 'string', description: 'For `move_session`: place the session before this one; omit to append.' },
        create_directory: { type: 'boolean', description: 'For `create`: create the directory when it does not exist yet.' },
        limit: LIMIT,
      },
      required: ['action'],
    },
    output: OUTPUT,
    async execute(args) {
      switch (args.action) {
        case 'list': {
          const registry = service(ctx, 'workspaceRegistry')
          const workspaces = registry.list()
          const page = bounded(workspaces, limitOf(args.limit, options.maxItems))
          return { workspaces: page.items.map(workspaceRow), total: page.total, truncated: page.truncated }
        }
        case 'create': {
          if (typeof args.path !== 'string' || args.path.trim() === '') throw new Error('path is required for `create`')
          if (args.create_directory === true) ensureDirectory(args.path)
          const controller = service(ctx, 'workspaceController')
          const created = await call(`registering ${args.path}`, () => controller.create({ path: args.path }))
          const result = { ...workspaceRow(created.workspace), created: created.created }
          if (created.created && typeof args.title === 'string' && args.title.trim() !== '') {
            const renamed = await call('titling the new workspace', () => controller.rename({
              workspaceId: created.workspace.workspaceId,
              title: args.title,
            }))
            Object.assign(result, workspaceRow(renamed.workspace))
          }
          return result
        }
        case 'rename': {
          if (typeof args.workspace_id !== 'string' || args.workspace_id === '') throw new Error('workspace_id is required for `rename`')
          if (typeof args.title !== 'string' || args.title.trim() === '') throw new Error('title is required for `rename`')
          const renamed = await call('renaming the workspace', () => service(ctx, 'workspaceController').rename({
            workspaceId: args.workspace_id,
            title: args.title,
          }))
          return workspaceRow(renamed.workspace)
        }
        case 'delete': {
          if (typeof args.workspace_id !== 'string' || args.workspace_id === '') throw new Error('workspace_id is required for `delete`')
          const value = await call('removing the workspace', () => service(ctx, 'workspaceController').delete({ workspaceId: args.workspace_id }))
          return { workspace_id: args.workspace_id, deleted: value.deleted }
        }
        case 'reorder': {
          if (typeof args.workspace_id !== 'string' || args.workspace_id === '') throw new Error('workspace_id is required for `reorder`')
          const request = { workspaceId: args.workspace_id }
          if (typeof args.before_workspace_id === 'string' && args.before_workspace_id !== '') {
            request.beforeWorkspaceId = args.before_workspace_id
          }
          const value = await call('reordering workspaces', () => service(ctx, 'workspaceController').insertBefore(request))
          return { order: value.workspaceIds }
        }
        case 'move_session': {
          if (typeof args.workspace_id !== 'string' || args.workspace_id === '') throw new Error('workspace_id is required for `move_session`')
          if (typeof args.session_id !== 'string' || args.session_id === '') throw new Error('session_id is required for `move_session`')
          const request = { workspaceId: args.workspace_id, sessionId: args.session_id }
          if (typeof args.before_session_id === 'string' && args.before_session_id !== '') {
            request.beforeSessionId = args.before_session_id
          }
          const value = await call('moving the session', () => service(ctx, 'workspaceController').insertSessionBefore(request))
          return workspaceRow(value.workspace)
        }
        default:
          throw new Error(`unknown action: ${String(args.action)}`)
      }
    },
  }
}

/* ------------------------------------------------------------------ */
/* dsh_gui_mode                                                        */
/* ------------------------------------------------------------------ */

function authorityOf(spec) {
  const sandbox = spec !== undefined && typeof spec.sandbox === 'string' ? SANDBOX_RANK[spec.sandbox] : undefined
  return {
    sandbox: sandbox === undefined ? 9 : sandbox,
    approval: spec !== undefined && spec.approval === 'never' ? 1 : 0,
  }
}

function widens(from, to) {
  if (from === undefined) return true
  const before = authorityOf(from)
  const after = authorityOf(to)
  return after.sandbox > before.sandbox || after.approval > before.approval
}

function modeTool(ctx, options) {
  return {
    name: 'dsh_gui_mode',
    description:
      'Read or change how a session is allowed to act. `list` shows the permission modes this deployment offers and the one in force. '
      + '`set` switches the permission mode: narrowing is always allowed, while raising the sandbox level or dropping approval prompts '
      + 'is refused unless the plugin\'s modeWidening setting is "allow".',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', description: 'Operation to perform.', enum: ['list', 'set'] },
        session_id: SESSION_ID,
        mode: { type: 'string', description: 'Permission mode id to switch to, for `set`; ids come from `list`.' },
      },
      required: ['action'],
    },
    output: OUTPUT,
    async execute(args, exec) {
      const presets = service(ctx, 'permissionPresets')
      const sessionId = callingSessionId(args, exec)
      switch (args.action) {
        case 'list': {
          const session = await sessionOf(ctx, sessionId)
          const catalog = presets.catalog()
          const current = presets.current(session)
          const result = {
            session_id: sessionId,
            current,
            default_mode: catalog.defaultPreset,
            modes: catalog.options.map((option) => {
              const row = { mode: option.value, name: option.name }
              if (typeof option.description === 'string') row.description = option.description
              return row
            }),
          }
          return result
        }
        case 'set': {
          if (typeof args.mode !== 'string' || args.mode.trim() === '') throw new Error('mode is required for `set`')
          const session = await sessionOf(ctx, sessionId)
          const current = presets.current(session)
          if (current === args.mode) return { session_id: sessionId, mode: current, changed: false }
          let target
          try {
            target = presets.resolve(args.mode)
          } catch (error) {
            throw new Error(`unknown permission mode ${args.mode}: ${describeError(error)}`)
          }
          if (!options.modeWidening) {
            let baseline
            if (current !== 'custom') {
              try {
                baseline = presets.resolve(current)
              } catch {
                baseline = undefined
              }
            }
            if (widens(baseline, target)) {
              throw new Error(
                `refusing to widen session ${sessionId} from ${current} to ${args.mode}: this tool may narrow a session's authority `
                + 'but not raise it. Ask the user to switch the mode, or set the plugin\'s modeWidening setting to "allow".',
              )
            }
          }
          await call(`switching session ${sessionId} to ${args.mode}`, async () => presets.set(session, args.mode))
          return { session_id: sessionId, mode: presets.current(session), previous: current, changed: true }
        }
        default:
          throw new Error(`unknown action: ${String(args.action)}`)
      }
    },
  }
}

/* ------------------------------------------------------------------ */
/* dsh_gui_settings                                                    */
/* ------------------------------------------------------------------ */

function settingsTool(ctx, options) {
  return {
    name: 'dsh_gui_settings',
    description:
      'Read and write DeepSeek Harness settings, the same namespaced configuration the Settings page edits. `describe` lists namespaces, '
      + 'or returns one namespace\'s schema, values, and revision. `update`, `replace`, and `mutate` persist a change; pass the revision '
      + 'from `describe` to fail instead of overwriting a concurrent edit. Secret values are never returned.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', description: 'Operation to perform.', enum: ['describe', 'update', 'replace', 'mutate'] },
        namespace: {
          type: 'string',
          description: 'Settings namespace key, from `describe`. Required for every writing action.',
        },
        patch: {
          type: 'object',
          additionalProperties: true,
          description: 'Fields to merge into the namespace, for `update`.',
        },
        section: {
          type: 'object',
          additionalProperties: true,
          description: 'Complete replacement user section, for `replace`.',
        },
        ops: {
          type: 'array',
          description: 'Path-addressed edits applied in order, for `mutate`.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              op: { type: 'string', enum: ['set', 'unset'] },
              path: { type: 'array', items: { type: 'string' } },
              value: {},
            },
            required: ['op', 'path'],
          },
        },
        expected_revision: {
          type: 'integer',
          description: 'Revision read from `describe`; the write fails instead of overwriting when it is stale.',
        },
      },
      required: ['action'],
    },
    output: OUTPUT,
    async execute(args) {
      const controller = service(ctx, 'settingsController')
      switch (args.action) {
        case 'describe': {
          const described = await call('reading settings', async () => controller.describe())
          const namespaces = described.namespaces
          if (typeof args.namespace === 'string' && args.namespace !== '') {
            const found = namespaces.find((entry) => entry.ns === args.namespace)
            if (found === undefined) {
              throw new Error(`no settings namespace ${args.namespace}; available: ${namespaces.map((entry) => entry.ns).join(', ')}`)
            }
            return {
              writable: described.writable,
              ns: found.ns,
              revision: found.revision,
              applies: found.applies,
              schema: found.schema,
              value: found.value,
              user: found.user,
              secret_paths: found.secrets,
            }
          }
          return {
            writable: described.writable,
            has_document: described.hasDocument,
            total: namespaces.length,
            namespaces: namespaces.map((entry) => ({
              ns: entry.ns,
              revision: entry.revision,
              applies: entry.applies,
              has_user_section: entry.user !== undefined,
              secret_paths: entry.secrets.map((secret) => secret.path.join('.')),
            })),
          }
        }
        case 'update': {
          requireNamespace(args)
          if (args.patch === null || typeof args.patch !== 'object') throw new Error('patch is required for `update`')
          const view = await call(`updating settings ${args.namespace}`, () => controller.update(
            args.namespace,
            args.patch,
            Number.isInteger(args.expected_revision) ? args.expected_revision : undefined,
          ))
          return { ns: view.ns, revision: view.revision, value: view.value }
        }
        case 'replace': {
          requireNamespace(args)
          if (args.section === null || typeof args.section !== 'object') throw new Error('section is required for `replace`')
          const view = await call(`replacing settings ${args.namespace}`, () => controller.replace(
            args.namespace,
            args.section,
            Number.isInteger(args.expected_revision) ? args.expected_revision : undefined,
          ))
          return { ns: view.ns, revision: view.revision, value: view.value }
        }
        case 'mutate': {
          requireNamespace(args)
          if (!Array.isArray(args.ops) || args.ops.length === 0) throw new Error('ops is required for `mutate`')
          const ops = args.ops.map((entry) => {
            if (entry === null || typeof entry !== 'object' || !Array.isArray(entry.path)) {
              throw new Error('every op needs `path`')
            }
            return entry.op === 'unset'
              ? { op: 'unset', path: entry.path }
              : { op: 'set', path: entry.path, value: entry.value }
          })
          const view = await call(`editing settings ${args.namespace}`, () => controller.mutate(
            args.namespace,
            ops,
            Number.isInteger(args.expected_revision) ? args.expected_revision : undefined,
          ))
          return { ns: view.ns, revision: view.revision, value: view.value }
        }
        default:
          throw new Error(`unknown action: ${String(args.action)}`)
      }
    },
  }
}

function requireNamespace(args) {
  if (typeof args.namespace !== 'string' || args.namespace === '') {
    throw new Error('namespace is required for this action')
  }
}

/* ------------------------------------------------------------------ */
/* dsh_gui_market                                                      */
/* ------------------------------------------------------------------ */

function pickIndex(market, url) {
  const indexes = market.listIndexes()
  if (indexes.length === 0) {
    throw new Error('no plugin market index is configured; add one in the GUI under Settings > Plugins. The installation\'s own bundle catalog is available through the `catalog` action')
  }
  if (typeof url !== 'string' || url === '') return indexes[0].url
  if (!indexes.some((entry) => entry.url === url)) {
    throw new Error(`unknown market index ${url}; configured: ${indexes.map((entry) => entry.url).join(', ')}`)
  }
  return url
}

function listingRow(entry) {
  const row = { name: entry.name, installed: entry.installation.status }
  if (typeof entry.title === 'string') row.title = entry.title
  if (entry.description !== undefined) row.description = entry.description
  if (typeof entry.author === 'string') row.author = entry.author
  if (typeof entry.defaultVersion === 'string') row.default_version = entry.defaultVersion
  if (entry.installation.installedVersion !== undefined) row.installed_version = entry.installation.installedVersion
  if (entry.metadata.category !== undefined) row.category = entry.metadata.category
  if (Array.isArray(entry.metadata.keywords) && entry.metadata.keywords.length > 0) row.keywords = entry.metadata.keywords.slice(0, 8)
  const versions = entry.versions ?? []
  if (versions.length > 0) {
    row.versions = versions.slice(0, 6).map((version) => ({
      version: version.version,
      compatible: version.compatibility.compatible,
    }))
  }
  return row
}

function localized(value) {
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object') {
    if (typeof value.en === 'string') return value.en
    for (const key of Object.keys(value)) {
      if (typeof value[key] === 'string') return value[key]
    }
  }
  return undefined
}

function changeRow(result) {
  const row = { changed: result.changed, application: result.application, stage: result.stage, target: result.target }
  if (result.enabled !== undefined) row.enabled = result.enabled
  if (result.restartReason !== undefined) row.restart_reason = result.restartReason
  if (result.error !== undefined) row.error = result.error.code
  if (Array.isArray(result.warnings) && result.warnings.length > 0) row.warnings = result.warnings
  return row
}

function marketTool(ctx, options) {
  return {
    name: 'dsh_gui_market',
    description:
      'Browse and govern DeepSeek Harness plugins. `catalog` lists the plugin bundles this installation offers and the profile has, '
      + 'including official ones not installed yet, with the install spec to hand to plugin_manager. `indexes`, `search`, and `detail` '
      + 'read remote market indexes configured under Settings > Plugins. `installed` lists bundles and plugin rows with their status, '
      + 'and `enable`/`disable` toggle one. Installing, updating, and removing packages stays with the approval-gated plugin_manager tool.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          description: 'Operation to perform.',
          enum: ['catalog', 'indexes', 'search', 'detail', 'installed', 'enable', 'disable'],
        },
        name: { type: 'string', description: 'Plugin package name, for `detail`.' },
        version: { type: 'string', description: 'Version to describe, for `detail`. Defaults to the entry\'s default version.' },
        index_url: { type: 'string', description: 'Market index URL, from `indexes`. Defaults to the first configured index.' },
        text: { type: 'string', description: 'Search words, for `search`.' },
        category: { type: 'string', description: 'Category filter, for `search`.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Label filter, for `search`.' },
        offset: { type: 'integer', description: 'Zero-based result offset, for `search`. Defaults to 0.' },
        limit: LIMIT,
        refresh: { type: 'boolean', description: 'For `search` and `detail`: fetch the index instead of reusing the cached copy.' },
        installed_only: {
          type: 'boolean',
          description: 'For `catalog`: return only bundles that are installed or provided by the installation.',
        },
        language: { type: 'string', description: 'Display language for `detail`, such as `zh-CN`. Defaults to the plugin\'s language setting.' },
        kind: {
          type: 'string',
          enum: ['bundle', 'plugin'],
          description: 'What `target` names: a bundle package for `enable`/`disable` (default), or a plugin entry id.',
        },
        target: { type: 'string', description: 'Bundle package name or plugin entry id, for `enable`/`disable`.' },
      },
      required: ['action'],
    },
    output: OUTPUT,
    async execute(args) {
      switch (args.action) {
        case 'catalog': {
          const manager = service(ctx, 'pluginManager')
          const bundles = await call('reading the bundle catalog', () => manager.listBundles())
          const needle = typeof args.text === 'string' ? args.text.trim().toLowerCase() : ''
          const matched = bundles.filter((bundle) => {
            if (args.installed_only === true && !bundle.installed) return false
            if (needle === '') return true
            const haystack = `${bundle.name} ${bundle.description ?? ''} ${localized(bundle.meta?.title) ?? ''}`.toLowerCase()
            return haystack.includes(needle)
          })
          const page = bounded(matched, limitOf(args.limit, options.maxItems))
          return {
            total: page.total,
            truncated: page.truncated,
            bundles: page.items.map((bundle) => {
              const row = {
                name: bundle.name,
                official: bundle.official,
                availability: bundle.availability,
                installed: bundle.installed,
                enabled: bundle.enabled,
              }
              const title = localized(bundle.meta?.title)
              if (title !== undefined) row.title = title
              if (bundle.description !== undefined) row.description = bundle.description
              if (bundle.version !== undefined) row.version = bundle.version
              if (bundle.installTarget !== undefined) {
                row.install_spec = bundle.installTarget.spec
                row.install_version = bundle.installTarget.version
              } else if (typeof bundle.version === 'string') {
                row.install_spec = `${bundle.name}@${bundle.version}`
              }
              if (bundle.update !== undefined) row.update = bundle.update
              if (bundle.error !== undefined) row.error = bundle.error.code
              return row
            }),
          }
        }
        case 'indexes': {
          const market = service(ctx, 'pluginMarket')
          const indexes = market.listIndexes()
          return {
            total: indexes.length,
            indexes: indexes.map((entry) => {
              const row = { url: entry.url }
              if (entry.title !== undefined) row.title = entry.title
              if (entry.description !== undefined) row.description = entry.description
              if (entry.error !== undefined) row.error = entry.error
              return row
            }),
          }
        }
        case 'search': {
          const market = service(ctx, 'pluginMarket')
          const url = pickIndex(market, args.index_url)
          const query = {
            offset: Number.isInteger(args.offset) && args.offset >= 0 ? args.offset : 0,
            limit: limitOf(args.limit, 20),
            sort: typeof args.text === 'string' && args.text !== '' ? { kind: 'relevance' } : { kind: 'index' },
          }
          if (typeof args.text === 'string' && args.text !== '') query.text = args.text
          if (typeof args.category === 'string' && args.category !== '') query.category = args.category
          if (Array.isArray(args.labels) && args.labels.length > 0) query.labels = args.labels
          if (args.refresh === true) query.refresh = true
          const result = await call(`searching ${url}`, () => market.search(url, query))
          return {
            index: { url: result.url, title: result.title },
            total: result.total,
            next_offset: result.nextOffset,
            plugins: result.entries.map(listingRow),
          }
        }
        case 'detail': {
          if (typeof args.name !== 'string' || args.name === '') throw new Error('name is required for `detail`')
          const market = service(ctx, 'pluginMarket')
          const url = pickIndex(market, args.index_url)
          const entry = await call(`reading ${args.name} from ${url}`, () => market.entry(url, args.name))
          if (entry === undefined) throw new Error(`the index does not list ${args.name}`)
          const version = typeof args.version === 'string' ? args.version
            : typeof entry.defaultVersion === 'string' ? entry.defaultVersion
              : entry.versions[0]?.version
          if (version === undefined) throw new Error(`${args.name} lists no versions`)
          const language = typeof args.language === 'string' && args.language !== '' ? args.language : options.language
          const detail = await call(`reading the description of ${args.name}@${version}`, () => market.readEntryDetail(
            url,
            args.name,
            version,
            language,
            args.refresh === true ? { refresh: true } : undefined,
          ))
          if (detail.status === 'none') return { name: args.name, version, documentation: 'none' }
          const markdown = detail.markdown.length > 8000
            ? `${detail.markdown.slice(0, 8000)}\n\n[truncated: ${detail.markdown.length - 8000} more characters]`
            : detail.markdown
          return { name: args.name, version, origin: detail.origin, markdown }
        }
        case 'installed': {
          const manager = service(ctx, 'pluginManager')
          const [bundles, plugins] = await call('reading installed plugins', () => Promise.all([
            manager.listBundles(),
            manager.listPlugins(),
          ]))
          const limit = limitOf(args.limit, options.maxItems)
          const bundlePage = bounded(bundles, limit)
          const pluginPage = bounded(plugins, limit)
          return {
            bundles: bundlePage.items.map((bundle) => {
              const row = {
                name: bundle.name,
                enabled: bundle.enabled,
                installed: bundle.installed,
                availability: bundle.availability,
              }
              if (bundle.version !== undefined) row.version = bundle.version
              if (bundle.description !== undefined) row.description = bundle.description
              if (bundle.update !== undefined) row.update = bundle.update
              if (bundle.error !== undefined) row.error = bundle.error.code
              return row
            }),
            bundles_truncated: bundlePage.truncated,
            plugins: pluginPage.items.map((plugin) => {
              const row = {
                entry_id: plugin.entryId,
                module: plugin.moduleName,
                enabled: plugin.enabled,
                phase: plugin.fiberPhase,
              }
              if (plugin.meta?.title !== undefined) row.title = plugin.meta.title
              if (plugin.readOnlyReason !== undefined) row.read_only = plugin.readOnlyReason
              if (plugin.diagnostic !== undefined) row.diagnostic = plugin.diagnostic
              return row
            }),
            plugins_truncated: pluginPage.truncated,
          }
        }
        case 'enable':
        case 'disable': {
          if (!options.marketToggle) throw new Error('enabling and disabling plugins is turned off by the plugin\'s marketToggle setting')
          if (typeof args.target !== 'string' || args.target === '') throw new Error('target is required for this action')
          const manager = service(ctx, 'pluginManager')
          const enabled = args.action === 'enable'
          const result = args.kind === 'plugin'
            ? await call(`${args.action} ${args.target}`, () => manager.setPluginEnabled(args.target, enabled))
            : await call(`${args.action} ${args.target}`, () => manager.setBundleEnabled(args.target, enabled))
          return changeRow(result)
        }
        default:
          throw new Error(`unknown action: ${String(args.action)}`)
      }
    },
  }
}

/* ------------------------------------------------------------------ */
/* plugin                                                              */
/* ------------------------------------------------------------------ */

export function apply(ctx, config) {
  const options = resolveOptions(config)
  const tools = [
    sessionTool(ctx, options),
    workspaceTool(ctx, options),
    modeTool(ctx, options),
    settingsTool(ctx, options),
    marketTool(ctx, options),
  ]
  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool))
  }
}
