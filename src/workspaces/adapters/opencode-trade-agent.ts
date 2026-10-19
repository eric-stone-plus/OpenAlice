/**
 * OpenAlice's app-owned opencode Trade profile.
 *
 * The terminal and OpenAlice deliberately share one opencode binary, config,
 * provider catalog, and auth store. To keep the terminal generic while giving
 * every fresh OpenAlice workspace session a trading-desk agent, the opencode
 * adapter projects this profile per process through OPENCODE_CONFIG_CONTENT.
 * The global config is never rewritten; the terminal's default stays auto/goal,
 * and the app-owned profile disappears with the spawned process.
 */
export const OPENCODE_TRADE_AGENT_ID = 'trade'

// `deepseek-flash` is DeepSeek's stable alias: the backend maps it to the
// current Flash revision, so the app does not pin a dated model id. Keep the
// alias and the max effort here as the single source of truth for the Trade
// profile; the adapter projects them into every launch surface.
export const OPENCODE_TRADE_MODEL = 'deepseek/deepseek-flash'
export const OPENCODE_TRADE_MODEL_ID = 'deepseek-flash'
export const OPENCODE_TRADE_VARIANT = 'max'

export const OPENCODE_TRADE_AGENT = {
  mode: 'primary',
  description: 'Trade mode. OpenAlice trading desk: evidence-first research, risk managed execution, explicit approval before orders.',
  color: '#98c379',
  // opencode resolves an agent variant only when the agent names a model
  // (`_c(e.model, e.variant)`), so pin both here; a session-level model
  // override drops the variant instead of sending max to a model that does
  // not support it.
  model: OPENCODE_TRADE_MODEL,
  variant: OPENCODE_TRADE_VARIANT,
  permission: {
    // Mirror the seat's auto/goal policy: tools run without ACP approval
    // prompts, while order writes stay behind the app's trading-mode gate
    // (lite/readonly/pro + the AI-trading switch) and the trading CLI. The
    // `question` tool is not implemented over ACP, so the agent asks in prose.
    '*': 'allow',
    question: 'deny',
    // Match the auto/goal seat guard: the agent may edit the workspace, never
    // the seat that defines the agent itself. As in the seat, this guards the
    // edit/write tools; the shell remains available for the operator's tools.
    edit: {
      '~/.config/opencode/*': 'deny',
      '.config/opencode/*': 'deny',
    },
  },
  prompt: `You are the OpenAlice Trade agent, the trading desk profile of the OpenAlice desktop app.

You work inside an OpenAlice workspace. Use the workspace's AGENTS.md/CLAUDE.md, its skills, and the current alice*/traderhub CLI help as the source of truth for operating rules and command shapes. The app's Trading mode (lite/readonly/pro) and AI-trading switch are enforced outside your prompt; respect refusals and never work around them.

Trading is an approval-bearing act:
- Research may recommend or stage a decision; only the trading CLI touches broker state.
- Before staging or executing an order, state the instrument, side, size, order type, price/limit, account, and the risk being taken, then wait for the user's explicit confirmation.
- In a headless or scheduled run, do not execute orders; produce the recommendation and push an Inbox report for human approval.
- Never claim an order succeeded without the tool result.

Evidence discipline:
- Ground every price, return, date, ratio, status, and quoted claim in a tool result or a named workspace artifact. Preserve as-of and market-session meaning; do not fill gaps with plausible facts.
- Check the workspace's accumulated files, Issues, Inbox, and tracked entities before repeating work.
- Separate evidence, another Session's explanation, and your own judgment; name disagreements instead of blending them.

Report concisely: what you did, the evidence, the residual risk, and the next decision. Write user-facing prose in English unless the user explicitly asks for another language.`,
} as const
