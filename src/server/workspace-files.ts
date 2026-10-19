import type { Hono } from 'hono'
import { readWorkspaceBinaryFile } from '../workspaces/binary-file.js'
import { isSecretWorkspacePath } from '../workspaces/secret-paths.js'

/** Mounted on the existing loopback tool listener, never a public bypass. */
export function registerWorkspaceFileRoutes(app: Hono, resolveWorkspace: (id: string) => { dir: string } | undefined): void {
  app.get('/cli/workspace-files/:id', async c => {
    c.header('Cache-Control', 'no-store')
    // The CLI shims do not send Origin. A browser page always does; refusing
    // it removes the cross-origin read/CSRF path without a token round-trip.
    if (c.req.header('origin')) return c.json({ error: 'origin_not_allowed' }, 403)
    const requestedPath = c.req.query('path') ?? ''
    if (isSecretWorkspacePath(requestedPath)) {
      return c.json({ error: 'secret_path' }, 403)
    }
    const workspace = resolveWorkspace(c.req.param('id'))
    if (!workspace) return c.json({ error: 'workspace_unavailable' }, 404)
    try {
      const file = await readWorkspaceBinaryFile(workspace.dir, requestedPath)
      return c.json({ filename: file.filename, contentBase64: file.content.toString('base64') })
    } catch (error) {
      const code = error instanceof Error ? error.message : ''
      return c.json({ error: ['invalid_path', 'not_regular_file', 'file_too_large'].includes(code) ? code : 'file_unavailable' }, 400)
    }
  })
}
