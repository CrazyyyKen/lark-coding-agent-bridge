import { log } from '../core/logger';
import { signInCard, whoamiCard } from '../card/templates';
import { loginLinkMinutes, type PerUserLogins } from '../lark-cli/per-user-login';
import type { CommandContext } from './index';

/**
 * /login, /logout, /whoami — a team member's own Lark sign-in (profile
 * `team.perUserLogin`). Open to everyone: each command only ever touches the
 * sender's own login folder, chosen from the message's sender, never from
 * arguments.
 */

const NOT_ENABLED =
  "Personal sign-in isn't turned on for this bot, so it only uses its own (bot) identity.";
const DM_ONLY = 'Please send this to me in a private chat — sign-in links are personal.';

export async function handleLogin(_args: string, ctx: CommandContext): Promise<void> {
  const logins = loginsFor(ctx);
  if (!logins) return send(ctx, NOT_ENABLED);
  if (ctx.chatMode !== 'p2p') return send(ctx, DM_ONLY);
  const openId = ctx.msg.senderId;
  const status = await logins.status(openId, true);
  if (status.loggedIn) {
    const name = status.userName?.trim();
    await send(
      ctx,
      `You're already signed in${name ? ` as **${name}**` : ''}. Send \`/logout\` first to switch accounts.`,
    );
    return;
  }
  try {
    const login = await logins.startLogin(openId, (markdown) => notifyDm(ctx, markdown));
    await sendCard(
      ctx,
      signInCard({ url: login.verificationUrl, minutes: loginLinkMinutes(login), welcome: false }),
    );
  } catch (err) {
    log.warn('per-user-login', 'login-start-failed', { user: openId.slice(-6), err: String(err) });
    await send(ctx, "Sorry — I couldn't start the sign-in. Please try again in a minute.");
  }
}

export async function handleLogout(_args: string, ctx: CommandContext): Promise<void> {
  const logins = loginsFor(ctx);
  if (!logins) return send(ctx, NOT_ENABLED);
  if (ctx.chatMode !== 'p2p') return send(ctx, DM_ONLY);
  const result = await logins.logout(ctx.msg.senderId);
  await send(
    ctx,
    result.ok
      ? "Done — I've removed your Lark sign-in. Send `/login` if you want to sign in again."
      : `Sorry — I couldn't remove your sign-in: ${result.message ?? 'unknown error'}`,
  );
}

export async function handleWhoami(_args: string, ctx: CommandContext): Promise<void> {
  const logins = loginsFor(ctx);
  if (!logins) return send(ctx, NOT_ENABLED);
  if (ctx.chatMode !== 'p2p') return send(ctx, DM_ONLY);
  const status = await logins.status(ctx.msg.senderId, true);
  const name = status.userName?.trim();
  await sendCard(
    ctx,
    whoamiCard({
      signedIn: status.loggedIn,
      ...(name ? { name } : {}),
      permissions: status.scopes.length,
    }),
  );
}

function loginsFor(ctx: CommandContext): PerUserLogins | undefined {
  return ctx.controls.teamLogin?.logins;
}

async function send(ctx: CommandContext, markdown: string): Promise<void> {
  try {
    await ctx.channel.send(ctx.msg.chatId, { markdown }, { replyTo: ctx.msg.messageId });
  } catch (err) {
    log.fail('command', err, { step: 'user-login-reply' });
  }
}

async function sendCard(ctx: CommandContext, card: object): Promise<void> {
  try {
    await ctx.channel.send(ctx.msg.chatId, { card }, { replyTo: ctx.msg.messageId });
  } catch (err) {
    log.fail('command', err, { step: 'user-login-card' });
  }
}

/** Later notices (signed in, wrong account) go to the same DM, not as replies. */
async function notifyDm(ctx: CommandContext, markdown: string): Promise<void> {
  await ctx.channel.send(ctx.msg.chatId, { markdown });
}
