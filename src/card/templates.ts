interface ButtonSpec {
  text: string;
  value: Record<string, unknown>;
  style?: 'primary' | 'danger' | 'default';
}

function button(spec: ButtonSpec): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: spec.text },
    type: spec.style ?? 'default',
    value: spec.value,
  };
}

function divMd(content: string): object {
  return { tag: 'div', text: { tag: 'lark_md', content } };
}

function actions(buttons: ButtonSpec[]): object {
  return { tag: 'action', actions: buttons.map(button) };
}

const HR: object = { tag: 'hr' };

function shell(title: string, elements: object[]): object {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: 'plain_text', content: title } },
    elements,
  };
}

export function workspacesCard(current: string | undefined, named: Record<string, string>): object {
  const entries = Object.entries(named);
  const elements: object[] = [];

  elements.push(divMd(`Current cwd: \`${escapeCode(current ?? '(not set)')}\``));

  if (entries.length === 0) {
    elements.push(HR);
    elements.push(divMd('No named workspaces yet.'));
    elements.push(
      divMd('💡 Send `/ws save <name>` to save the current cwd as a named workspace'),
    );
  } else {
    elements.push(HR);
    entries.forEach(([name, path], i) => {
      const marker = path === current ? '  ← current' : '';
      elements.push(divMd(`**${escapeMd(name)}** → \`${escapeCode(path)}\`${marker}`));
      elements.push(
        actions([
          { text: 'Switch here', value: { cmd: 'ws.use', name }, style: 'primary' },
          { text: 'Delete', value: { cmd: 'ws.remove', name }, style: 'danger' },
        ]),
      );
      if (i < entries.length - 1) elements.push(HR);
    });
  }

  return shell('📂 Workspaces', elements);
}

export interface StatusInfo {
  profileName: string;
  cwd?: string;
  sessionId?: string;
  emptySessionText?: string;
  sessionStale: boolean;
  agentName: string;
  runtimeAccess: {
    label: string;
    value: string;
  };
  larkCliStatus?: 'app' | 'user-ready' | 'user-missing' | 'check-failed';
  activeRun: boolean;
  activeScopes?: string[];
  activeCommentScopes?: string[];
  queue?: { active: number; waiting: number; cap: number };
  ownerState: string;
  /** Session scope (= chatId or chatId:threadId in topic groups). */
  scope: string;
  /** Chat mode — used to label scope. */
  chatMode: 'p2p' | 'group' | 'topic';
}

export function statusCard(info: StatusInfo): object {
  const sessionLine = info.sessionId
    ? `\`${info.sessionId.slice(0, 8)}…\`${info.sessionStale ? ' ⚠️ old cwd, next message starts a new session' : ''}`
    : (info.emptySessionText ?? '(none)');
  // For topic groups, surface that the scope is per-topic so the user
  // knows /cd / /new only affect this topic.
  const scopeLine =
    info.chatMode === 'topic'
      ? `\`${escapeCode(info.scope)}\` _(separate session per topic)_`
      : `\`${escapeCode(info.scope)}\``;
  const cwdLine = info.cwd ? `\`${escapeCode(info.cwd)}\`` : '(not set)';
  const queueLine = info.queue
    ? `${info.queue.active}/${info.queue.cap} active, ${info.queue.waiting} waiting`
    : 'unknown';
  const lines = [
    `🧭 **scope**: ${scopeLine}`,
    `🧩 **profile**: ${escapeMd(info.profileName)}`,
    `📁 **cwd**: ${cwdLine}`,
    `🔗 **session**: ${sessionLine}`,
    `🤖 **agent**: ${escapeMd(info.agentName)}`,
    `🛡 **${escapeMd(info.runtimeAccess.label)}**: ${escapeMd(info.runtimeAccess.value)}`,
    ...(info.larkCliStatus ? [`🔐 **lark-cli**: ${info.larkCliStatus}`] : []),
    `🏃 **active run**: ${info.activeRun ? 'yes' : 'no'}`,
    ...(info.activeScopes && info.activeScopes.length > 0
      ? [
          `🏃 **active scopes**: ${info.activeScopes.map((scope) => `\`${escapeCode(scope)}\``).join(', ')}`,
        ]
      : []),
    ...(info.activeCommentScopes && info.activeCommentScopes.length > 0
      ? [
          `📝 **comment runs**: ${info.activeCommentScopes.map((scope) => `\`${escapeCode(scope)}\``).join(', ')}`,
        ]
      : []),
    `🚦 **queue**: ${queueLine}`,
    `👤 **owner API**: ${escapeMd(info.ownerState)}`,
  ];
  return shell('📊 Status', [
    divMd(lines.join('\n')),
    HR,
    actions([
      { text: '🆕 New session', value: { cmd: 'new' }, style: 'primary' },
      { text: '🔁 Resume session', value: { cmd: 'resume' } },
      { text: '📂 Workspaces', value: { cmd: 'ws.list' } },
      { text: '💡 Help', value: { cmd: 'help' } },
    ]),
  ]);
}

export interface ResumeEntry {
  sessionId: string;
  displayId?: string;
  preview: string;
  relTime: string;
  lineCount?: number;
  detail?: string;
  current?: boolean;
}

export function resumeCard(cwd: string, entries: ResumeEntry[]): object {
  const elements: object[] = [];
  elements.push(divMd(`Current cwd: \`${escapeCode(cwd)}\``));

  if (entries.length === 0) {
    elements.push(HR);
    elements.push(divMd('No past sessions in this cwd.'));
    return shell('🔁 Resume a past session', elements);
  }

  elements.push(HR);
  entries.forEach((e, i) => {
    const marker = e.current ? '  ← current' : '';
    const detail = e.detail ?? `${e.lineCount ?? 0} lines`;
    const displayId = e.displayId ?? e.sessionId;
    elements.push(
      divMd(
        `**${i + 1}.** ${escapeMd(e.preview)}${marker}\n\`${displayId.slice(0, 8)}…\` · ${e.relTime} · ${escapeMd(detail)}`,
      ),
    );
    elements.push(
      actions([
        {
          text: e.current ? 'Current session' : '▸ Resume this session',
          value: { cmd: 'resume.use', arg: e.sessionId },
          style: e.current ? 'default' : 'primary',
        },
      ]),
    );
    if (i < entries.length - 1) elements.push(HR);
  });

  return shell('🔁 Resume a past session', elements);
}

export function helpCard(agentName = 'Agent', opts: { personalLogin?: boolean } = {}): object {
  const escapedAgentName = escapeMd(agentName);
  return shell('💡 Help', [
    divMd(
      [
        '**Commands**',
        '',
        ...(opts.personalLogin
          ? [
              '- `/login` — log in once with your own Lark account (send in DM)',
              '- `/whoami` — check your login status',
              '- `/logout` — remove your login',
            ]
          : []),
        '- `/new` `/reset` — clear the session for this chat',
        '- `/new chat [name]` — create a new group with a new session and add you to it',
        '- `/resume [N]` — list and resume past sessions (up to N)',
        '- `/cd <path>` — change workspace (resets the session)',
        '- `/ws list|save <name>|use <name>|remove <name>` — named workspaces',
        '- `/account` — show the current app; `/account change` switches appId/secret and reconnects',
        '- `/config` — preferences, access control and lark-cli identity',
        '- `/status` — current status',
        '- `/stop` — stop the running task (or tap ⏹ Stop at the bottom of the card)',
        '- `/stop comment:<scopeHash>` — admin: stop a doc comment task',
        '- `/timeout [N|off|default]` — inactivity check minutes for this session; `/config` sets the global default',
        '- `/timeout comment:<scopeHash> N` — admin: set the inactivity check for a doc comment task',
        '- `/ps` — list all bots on this machine and mark the one replying',
        '- `/exit <id|#>` — shut down a bot (see `/ps` for the id/number)',
        '- `/reconnect` — force a WebSocket reconnect (when the bot stops responding after a network blip)',
        '- `/invite user|admin|group` — admin: grant access (user DM, admin, or this group)',
        '- `/remove user|admin|group` — admin: revoke access',
        '- `/meeting join|notes|ask|leave` — admin: meeting agent (join a meeting, take notes, answer questions)',
        `- \`/doctor [description]\` — hand the logs and your description to ${escapedAgentName} to diagnose`,
        '- `/help` — this help',
        '',
        `Anything else goes straight to ${escapedAgentName}.`,
      ].join('\n'),
    ),
    HR,
    actions([
      { text: '📊 Status', value: { cmd: 'status' }, style: 'primary' },
      { text: '🔁 Resume session', value: { cmd: 'resume' } },
      { text: '📂 Workspaces', value: { cmd: 'ws.list' } },
      { text: '🆕 New session', value: { cmd: 'new' } },
    ]),
  ]);
}

function escapeMd(s: string): string {
  return s.replace(/([*_`\\])/g, '\\$1');
}

function escapeCode(s: string): string {
  return s.replace(/`/g, "'");
}
