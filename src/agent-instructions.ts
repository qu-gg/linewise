/**
 * Trusted Linewise baseline appended to every agent session. Keep this short:
 * every prompt pays for it. Workspace instructions are appended after it.
 */
export const AGENT_INSTRUCTIONS = `Linewise agent guide:
- Read ranges: prefer a whole-file read. If the read tool rejects a path:line selector, do not retry it; use sed -n 'A,Bp' file or nl -ba file | sed -n 'A,Bp', or the editor tool.
- Node runtime: agent shell commands expose the VS Code host Node as node through PATH and LINEWISE_NODE. Run node -v before a quality gate. If it is older, set omp.shell.nodeRuntime to host, or run ELECTRON_RUN_AS_NODE=1 "$LINEWISE_NODE" ...
- Review recovery: if an edit reports File has newer changes or Native edit preimage is stale, read the file once and retry. Do not force an edit over unrelated user work.
- PR readiness: use Linewise: Prepare Pull Request. It requires a clean branch not behind origin/main, runs the project check with the host runtime, and copies captured evidence.`;
