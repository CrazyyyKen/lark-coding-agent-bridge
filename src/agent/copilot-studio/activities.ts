/**
 * Bot Framework activity shapes as returned by Direct Line for a Copilot
 * Studio agent, plus rendering helpers. Only the fields the bridge reads
 * are typed; everything else is passed through untouched.
 */

export interface DirectLineAttachment {
  contentType?: string;
  content?: unknown;
  contentUrl?: string;
  name?: string;
}

export interface DirectLineActivity {
  type?: string;
  id?: string;
  timestamp?: string;
  from?: { id?: string; name?: string; role?: string };
  text?: string;
  textFormat?: string;
  attachments?: DirectLineAttachment[];
  suggestedActions?: { actions?: Array<{ title?: string; value?: unknown; type?: string }> };
  replyToId?: string;
  channelData?: Record<string, unknown>;
  name?: string;
  value?: unknown;
  code?: string;
}

/** Render a bot message activity into markdown for Lark. */
export function renderBotMessage(activity: DirectLineActivity): string {
  const parts: string[] = [];
  const text = typeof activity.text === 'string' ? activity.text.trim() : '';
  if (text) parts.push(text);
  for (const attachment of activity.attachments ?? []) {
    const rendered = renderAttachment(attachment);
    if (rendered) parts.push(rendered);
  }
  const actions = (activity.suggestedActions?.actions ?? [])
    .map((action) => (typeof action.title === 'string' ? action.title.trim() : ''))
    .filter(Boolean);
  if (actions.length > 0) {
    parts.push(`建议操作：${actions.map((title) => `「${title}」`).join(' ')}`);
  }
  return parts.join('\n\n');
}

function renderAttachment(attachment: DirectLineAttachment): string {
  const type = attachment.contentType ?? '';
  if (type === 'application/vnd.microsoft.card.adaptive') {
    const lines = collectAdaptiveCardText(attachment.content);
    return lines.length > 0 ? lines.join('\n') : '（Copilot Studio 发送了一张卡片，Lark 中无法显示其内容。）';
  }
  if (type.startsWith('application/vnd.microsoft.card.')) {
    const card = (attachment.content ?? {}) as {
      title?: unknown;
      subtitle?: unknown;
      text?: unknown;
      buttons?: Array<{ title?: unknown }>;
    };
    const lines = [card.title, card.subtitle, card.text]
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .map((v) => v.trim());
    const buttons = (card.buttons ?? [])
      .map((b) => (typeof b.title === 'string' ? b.title.trim() : ''))
      .filter(Boolean);
    if (buttons.length > 0) lines.push(`选项：${buttons.map((b) => `「${b}」`).join(' ')}`);
    return lines.join('\n');
  }
  if (attachment.contentUrl) {
    // Never fetch remote content on the model's behalf; just say it exists.
    return `（附件：${attachment.name ?? (type || '文件')}，未在 Lark 中展示）`;
  }
  return '';
}

/** Text of an Adaptive Card body: TextBlock / RichTextBlock / FactSet / actions. */
export function collectAdaptiveCardText(content: unknown, depth = 0): string[] {
  if (!content || typeof content !== 'object' || depth > 12) return [];
  if (Array.isArray(content)) return content.flatMap((item) => collectAdaptiveCardText(item, depth + 1));
  const node = content as Record<string, unknown>;
  const out: string[] = [];
  if (node.type === 'TextBlock' && typeof node.text === 'string' && node.text.trim()) {
    out.push(node.text.trim());
  }
  if (node.type === 'RichTextBlock' && Array.isArray(node.inlines)) {
    const text = node.inlines
      .map((inline) =>
        typeof inline === 'string'
          ? inline
          : typeof (inline as { text?: unknown })?.text === 'string'
            ? ((inline as { text: string }).text)
            : '',
      )
      .join('')
      .trim();
    if (text) out.push(text);
  }
  if (node.type === 'FactSet' && Array.isArray(node.facts)) {
    for (const fact of node.facts as Array<{ title?: unknown; value?: unknown }>) {
      if (typeof fact.title === 'string' || typeof fact.value === 'string') {
        out.push(`${String(fact.title ?? '')}: ${String(fact.value ?? '')}`.trim());
      }
    }
  }
  for (const key of ['body', 'items', 'columns', 'card']) {
    if (key in node) out.push(...collectAdaptiveCardText(node[key], depth + 1));
  }
  if (Array.isArray(node.actions)) {
    const titles = (node.actions as Array<{ title?: unknown }>)
      .map((a) => (typeof a.title === 'string' ? a.title.trim() : ''))
      .filter(Boolean);
    if (titles.length > 0) out.push(`选项：${titles.map((t) => `「${t}」`).join(' ')}`);
  }
  return out;
}

/**
 * Detect and strip the completion marker. Only a marker at the very end of
 * the message (ignoring trailing whitespace) counts, so the agent quoting
 * the protocol mid-answer does not end the turn.
 */
export function stripCompletionMarker(text: string, marker: string): { text: string; found: boolean } {
  if (!marker) return { text, found: false };
  const trimmed = text.trimEnd();
  if (!trimmed.endsWith(marker)) return { text, found: false };
  return { text: trimmed.slice(0, trimmed.length - marker.length).trimEnd(), found: true };
}

/**
 * Shape-only summary of an activity for logs and captured protocol
 * fixtures: no text, no card content, no ids that are not already opaque.
 */
export function sanitizeActivity(activity: DirectLineActivity, userId: string): Record<string, unknown> {
  return {
    type: activity.type ?? null,
    fromRole: activity.from?.id === userId ? 'bridge-user' : (activity.from?.role ?? 'bot'),
    hasId: Boolean(activity.id),
    hasReplyToId: Boolean(activity.replyToId),
    textChars: typeof activity.text === 'string' ? activity.text.length : 0,
    textFormat: activity.textFormat ?? null,
    attachmentTypes: (activity.attachments ?? []).map((a) => a.contentType ?? 'unknown'),
    suggestedActions: activity.suggestedActions?.actions?.length ?? 0,
    name: activity.type === 'event' ? (activity.name ?? null) : undefined,
    code: activity.code ?? undefined,
    channelDataKeys: activity.channelData ? Object.keys(activity.channelData).sort() : [],
  };
}
