import { modelLabel, supportedModels } from '../agent/models';
import type { KnownChat } from '../bot/lark-info';
import type { AgentKind, LarkCliIdentityPreset, ProfileMode } from '../config/profile-schema';
import type { CotMessagesMode, MessageReplyMode } from '../config/schema';

export interface ConfigFormOpts {
  /** Profile's agent kind — decides which model catalog the picker shows. */
  agentKind: AgentKind;
  /** Deployment mode: 'personal' (default) or 'team'. */
  mode: ProfileMode;
  /** Current model selection (a value from {@link supportedModels}). */
  model: string;
  messageReply: MessageReplyMode;
  showToolCalls: boolean;
  cotMessages: CotMessagesMode;
  maxConcurrentRuns: number;
  /** 0 means "disabled". */
  runIdleTimeoutMinutes: number;
  requireMentionInGroup: boolean;
  larkCliIdentity: LarkCliIdentityPreset;
  allowedUsers: string[];
  allowedChats: string[];
  admins: string[];
  knownChats: KnownChat[];
  /** URL of the running local web console (supervisor `--web-ui` mode). Shown
   * at the top of the card when present; omitted when no console is running. */
  consoleUrl?: string;
}

function collapsedAccessPanel(title: string, elements: object[]): object {
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: {
      title: { tag: 'markdown', content: title },
      vertical_align: 'center',
      icon: {
        tag: 'standard_icon',
        token: 'down-small-ccm_outlined',
        size: '16px 16px',
      },
      icon_position: 'follow_text',
      icon_expanded_angle: -180,
    },
    border: { color: 'blue', corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements,
  };
}

function atMentionLine(openIds: string[]): string {
  if (openIds.length === 0) return '_(none)_';
  return openIds.map((id) => `<at id="${id}"></at>`).join('  ');
}

function chatList(chatIds: string[], knownChats: KnownChat[]): string {
  if (chatIds.length === 0) return '_(none)_';
  const nameMap = new Map(knownChats.map((chat) => [chat.id, chat.name]));
  return chatIds
    .map((id) => `- **${nameMap.get(id) ?? '(unknown group)'}** (...${id.slice(-6)})`)
    .join('\n');
}

/** Form card for `/config`. */
export function configFormCard(opts: ConfigFormOpts): object {
  const teamMode = opts.mode === 'team';
  const teamOverrideNote =
    '\n\n_⚠️ Team mode is on: this setting is overridden. Identity is forced to "App identity only" and access control is off. Switch back to Personal to restore it._';
  const accessElements: object[] = [
    ...(teamMode
      ? [
          {
            tag: 'markdown',
            content:
              '_⚠️ **Team mode is on**: access control is paused. Anyone who @ the bot can use it (admin commands are still limited to the owner/admins). The allowlists below apply again when you switch back to Personal._',
          },
          { tag: 'hr' },
        ]
      : []),
    {
      tag: 'markdown',
      content: '_Controls who can use the bot in DMs and groups. **Empty = no replies to chat messages**. Doc comments follow the doc\'s own permissions._',
    },
    { tag: 'hr' },
    {
      tag: 'markdown',
      content:
        `**Users allowed to DM** (${opts.allowedUsers.length})\n` +
        `${atMentionLine(opts.allowedUsers)}\n\n` +
        '_Add / remove:_ `/invite user @someone`  `/remove user @someone`',
    },
    { tag: 'hr' },
    {
      tag: 'markdown',
      content:
        `**Allowed groups** (${opts.allowedChats.length})\n` +
        `${chatList(opts.allowedChats, opts.knownChats)}\n\n` +
        '_Add every group the bot is in:_ `/invite all group`\n' +
        '_Add / remove (send in the group):_ `/invite group`  `/remove group`',
    },
    { tag: 'hr' },
    {
      tag: 'markdown',
      content:
        `**Admins** (${opts.admins.length})\n` +
        `${atMentionLine(opts.admins)}\n\n` +
        '_Can run sensitive commands: `/account` `/config` `/exit` `/reconnect` `/doctor` `/cd` `/ws` `/invite` `/remove`. Admins can also DM the bot and manage access control in groups that are not on the allowlist._\n\n' +
        '_Add / remove:_ `/invite admin @someone`  `/remove admin @someone`',
    },
  ];

  return {
    schema: '2.0',
    config: { summary: { content: 'Settings' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content:
            '⚙️ **Settings**\n\n' +
            'Adjust how the bot behaves. Submit saves to the current profile config; message and access control settings take effect right away.',
        },
        ...(opts.consoleUrl
          ? [
              {
                tag: 'markdown',
                content:
                  `🖥️ **Web console** (this machine, 127.0.0.1; start/stop and configure every profile)\n` +
                  `[${opts.consoleUrl}](${opts.consoleUrl})`,
              },
            ]
          : []),
        { tag: 'hr' },
        {
          tag: 'form',
          name: 'config_form',
          elements: [
            {
              tag: 'markdown',
              content:
                '**Mode**\n' +
                '_Personal (default): the bot is your own assistant. Only you and allowlisted users can use it, and it can use your personal authorization for docs, calendar, etc._\n' +
                '_Team: the bot is shared by the team. Anyone can @ it (no allowlist check). So nobody can borrow your personal permissions through the bot, the CLI uses only the app (bot) identity in this mode, never personal authorization._',
            },
            {
              tag: 'select_static',
              name: 'deploy_mode',
              initial_option: opts.mode,
              options: [
                { text: { tag: 'plain_text', content: 'Personal (default)' }, value: 'personal' },
                { text: { tag: 'plain_text', content: 'Team' }, value: 'team' },
              ],
            },
            { tag: 'hr' },
            {
              tag: 'markdown',
              content:
                '**Model**\n' +
                '_The model the underlying agent runs on_\n' +
                '_"Use default" = not set; the CLI/account decides_',
            },
            {
              tag: 'select_static',
              name: 'model',
              initial_option: opts.model,
              options: supportedModels(opts.agentKind).map((m) => ({
                text: { tag: 'plain_text', content: m.label },
                value: m.value,
              })),
            },
            { tag: 'hr' },
            {
              tag: 'markdown',
              content:
                '**Reply style**\n' +
                '_Plain text: sent once when the agent finishes, no streaming, lightest feel_\n' +
                '_Message card: lightweight streaming markdown card with Lark\'s native typing animation_',
            },
            {
              tag: 'select_static',
              name: 'message_reply',
              // 'card' (交互卡片) is hidden from the picker for now; existing
              // configs with `messageReply: 'card'` still work — showConfigForm
              // displays them as 'markdown' in the form, but submitting only
              // overwrites if the user actually picks something.
              initial_option: opts.messageReply === 'card' ? 'markdown' : opts.messageReply,
              options: [
                { text: { tag: 'plain_text', content: 'Plain text' }, value: 'text' },
                { text: { tag: 'plain_text', content: 'Message card (default)' }, value: 'markdown' },
              ],
            },
            {
              tag: 'markdown',
              content:
                '\n**Tool calls**\n' +
                '_Show: see which commands the bot ran, which files it read, and so on_\n' +
                '_Hide: only the agent\'s final text reply, all tool blocks skipped_',
            },
            {
              tag: 'select_static',
              name: 'show_tool_calls',
              initial_option: opts.showToolCalls ? 'show' : 'hide',
              options: [
                { text: { tag: 'plain_text', content: 'Show (default)' }, value: 'show' },
                { text: { tag: 'plain_text', content: 'Hide' }, value: 'hide' },
              ],
            },
            {
              tag: 'markdown',
              content:
                '\n**COT progress messages**\n' +
                '_Off: send only the final reply_\n' +
                '_Brief: show the agent\'s progress text and tool summaries_\n' +
                '_Detailed: also show tool arguments and output summaries_',
            },
            {
              tag: 'select_static',
              name: 'cot_messages',
              initial_option: opts.cotMessages,
              options: [
                { text: { tag: 'plain_text', content: 'Off' }, value: 'off' },
                { text: { tag: 'plain_text', content: 'Brief' }, value: 'brief' },
                { text: { tag: 'plain_text', content: 'Detailed' }, value: 'detailed' },
              ],
            },
            {
              tag: 'markdown',
              content:
                '\n**Max concurrent runs**\n' +
                '_How many agent processes can run at once across the bot (mainly matters for topic groups with many topics in parallel)_\n' +
                '_Default 10, range 1-50. Extra requests queue FIFO_',
            },
            {
              tag: 'input',
              name: 'max_concurrent_runs',
              default_value: String(opts.maxConcurrentRuns),
              placeholder: { tag: 'plain_text', content: '10' },
              input_type: 'text',
            },
            {
              tag: 'markdown',
              content:
                '\n**Run inactivity check (minutes)**\n' +
                '_Kill the agent automatically when it produces no output for this long, so it cannot hang_\n' +
                '_0 = off (default), range 1-120. `/timeout` can override it for a single scope_',
            },
            {
              tag: 'input',
              name: 'run_idle_timeout_minutes',
              default_value: String(opts.runIdleTimeoutMinutes),
              placeholder: { tag: 'plain_text', content: '0' },
              input_type: 'text',
            },
            {
              tag: 'markdown',
              content:
                '\n**Require @ bot in groups**\n' +
                '_Yes (default): in groups and topic groups, messages that don\'t @ the bot get no reply; the bot stays out of group chatter_\n' +
                '_No: every message goes to the agent (behavior of 0.1.21 and earlier)_\n' +
                '_DMs never need an @; `@all` is never answered_',
            },
            {
              tag: 'select_static',
              name: 'require_mention_in_group',
              initial_option: opts.requireMentionInGroup ? 'yes' : 'no',
              options: [
                { text: { tag: 'plain_text', content: 'Yes (default)' }, value: 'yes' },
                { text: { tag: 'plain_text', content: 'No' }, value: 'no' },
              ],
            },
            {
              tag: 'markdown',
              content:
                '\n**lark-cli identity**\n' +
                '_App identity only: use bot/app capabilities, no access to personal resources_\n' +
                '_Allow user identity: keep the app identity, and let authorized users access their own calendar, mail, Drive, etc._' +
                (teamMode ? teamOverrideNote : ''),
            },
            {
              tag: 'select_static',
              name: 'lark_cli_identity',
              initial_option: opts.larkCliIdentity,
              options: [
                { text: { tag: 'plain_text', content: 'App identity only' }, value: 'bot-only' },
                { text: { tag: 'plain_text', content: 'Allow user identity' }, value: 'user-default' },
              ],
            },
            { tag: 'hr' },
            collapsedAccessPanel('🔒 **Access control** (tap to expand)', accessElements),
            {
              tag: 'column_set',
              flex_mode: 'flow',
              horizontal_spacing: 'small',
              columns: [
                {
                  tag: 'column',
                  width: 'auto',
                  elements: [
                    {
                      tag: 'button',
                      name: 'submit_btn',
                      text: { tag: 'plain_text', content: 'Submit' },
                      type: 'primary',
                      form_action_type: 'submit',
                      behaviors: [{ type: 'callback', value: { cmd: 'config.submit' } }],
                    },
                  ],
                },
                {
                  tag: 'column',
                  width: 'auto',
                  elements: [
                    {
                      tag: 'button',
                      name: 'cancel_btn',
                      text: { tag: 'plain_text', content: 'Cancel' },
                      behaviors: [{ type: 'callback', value: { cmd: 'config.cancel' } }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

export function configSavedCard(opts: ConfigFormOpts): object {
  const replyLabel =
    opts.messageReply === 'card'
      ? 'Interactive card'
      : opts.messageReply === 'markdown'
        ? 'Message card'
        : 'Plain text';
  const summarize = (list: string[]): string =>
    list.length === 0 ? '_(empty)_' : `${list.length} ${list.length === 1 ? 'entry' : 'entries'}`;
  const cotLabel = cotMessagesLabel(opts.cotMessages);
  return {
    schema: '2.0',
    config: { summary: { content: 'Settings saved' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content:
            '✅ **Settings saved**\n\n' +
            `**Mode**: \`${opts.mode === 'team' ? 'Team' : 'Personal'}\`\n` +
            `**Model**: \`${modelLabel(opts.agentKind, opts.model)}\`\n` +
            `**Reply style**: ${replyLabel}\n` +
            `**Tool calls**: \`${opts.showToolCalls ? 'show' : 'hide'}\`\n` +
            `**COT progress messages**: \`${cotLabel}\`\n` +
            `**Max concurrent runs**: \`${opts.maxConcurrentRuns}\`\n` +
            `**Run inactivity check**: \`${opts.runIdleTimeoutMinutes > 0 ? `${opts.runIdleTimeoutMinutes} min` : 'Off'}\`\n` +
            `**Require @ bot in groups**: \`${opts.requireMentionInGroup ? 'Yes' : 'No'}\`\n\n` +
            `**lark-cli identity**: \`${opts.mode === 'team' ? 'App identity only (forced by Team mode)' : opts.larkCliIdentity === 'user-default' ? 'Allow user identity' : 'App identity only'}\`\n\n` +
            '🔒 **Access control**' +
            (opts.mode === 'team' ? ' (_off in Team mode; anyone can use the bot_)' : '') +
            '\n' +
            `**Users allowed to DM**: ${summarize(opts.allowedUsers)}\n` +
            `**Allowed groups**: ${summarize(opts.allowedChats)}\n` +
            `**Admins**: ${summarize(opts.admins)}\n\n` +
            'Takes effect from the next message.',
        },
      ],
    },
  };
}

function cotMessagesLabel(value: CotMessagesMode): string {
  if (value === 'brief') return 'Brief';
  if (value === 'detailed') return 'Detailed';
  return 'Off';
}

/**
 * Shown after `/config` saves "群里不需要 @ bot" but the app is missing the
 * `im:message.group_msg` scope. Guides the user through one-click incremental
 * authorization via the link from `requestScopeGrantLink`.
 */
export function groupMsgScopeGrantCard(url: string, expireMins: number): object {
  return {
    schema: '2.0',
    config: { summary: { content: 'Authorization needed' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content:
            '⚠️ **"No @ needed in groups" is missing one permission**\n\n' +
            'You turned on "reply without @ bot", but the app lacks the **Read all messages in groups** (`im:message.group_msg`) permission. ' +
            'Without it, Lark does not deliver non-@ group messages to the bot, so this setting has no effect yet.\n\n' +
            `**Open the link below to grant it** (valid for about ${expireMins} min):\n` +
            `[🔗 Grant in one tap](${url})\n\n` +
            '_Scan or tap to open the confirmation page; the new permission is pre-filled, just confirm. Once granted, new group messages are picked up automatically, no restart needed._\n' +
            `_If the link does not open, copy this:_\n\`${url}\`\n\n` +
            '_If non-@ group messages still don\'t arrive after granting, send `/reconnect` once._',
        },
      ],
    },
  };
}

/** Replaces {@link groupMsgScopeGrantCard} in place once authorization completes. */
export function groupMsgScopeGrantedCard(): object {
  return {
    schema: '2.0',
    config: { summary: { content: 'Authorization granted' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content:
            '✅ **Authorization granted**\n\n' +
            'The `im:message.group_msg` permission is active. Group messages that don\'t @ the bot will now get replies.\n\n' +
            '_If it still doesn\'t work, send `/reconnect` once._',
        },
      ],
    },
  };
}

export function configCancelledCard(): object {
  return {
    schema: '2.0',
    config: { summary: { content: 'Cancelled' } },
    body: {
      elements: [{ tag: 'markdown', content: 'Cancelled, nothing changed.' }],
    },
  };
}

export function configFailedCard(reason: string): object {
  return {
    schema: '2.0',
    config: { summary: { content: 'Save failed' } },
    body: {
      elements: [{ tag: 'markdown', content: `Save failed: ${reason}` }],
    },
  };
}
