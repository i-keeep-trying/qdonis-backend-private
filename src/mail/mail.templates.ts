import type { MailMessage } from './mail.transport';

const APP_NAME = 'Qdonis';

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

function layout(heading: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f5f6f8;font-family:Arial,Helvetica,sans-serif;color:#1f2933">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px">
      <tr><td style="padding:32px">
        <h1 style="margin:0 0 16px;font-size:20px">${escapeHtml(heading)}</h1>
        ${bodyHtml}
        <p style="margin:32px 0 0;font-size:12px;color:#6b7280">${APP_NAME}</p>
      </td></tr>
    </table>
  </body>
</html>`;
}

function button(url: string, label: string): string {
  const safeUrl = escapeHtml(url);
  return `<p style="margin:24px 0"><a href="${safeUrl}" style="display:inline-block;padding:12px 20px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:bold">${escapeHtml(label)}</a></p>
<p style="font-size:13px;color:#4b5563">If the button does not work, paste this link into your browser:<br><span style="word-break:break-all">${safeUrl}</span></p>`;
}

const greeting = (name: string | null): string =>
  name ? `Hi ${name},` : 'Hi,';

export function verificationEmail(params: {
  to: string;
  name: string | null;
  url: string;
  expiresInText: string;
}): MailMessage {
  const hello = greeting(params.name);
  return {
    to: params.to,
    subject: `Verify your ${APP_NAME} email address`,
    text: `${hello}\n\nConfirm your email address by opening this link:\n${params.url}\n\nThe link expires in ${params.expiresInText}. If you did not create an account, ignore this email.`,
    html: layout(
      'Verify your email address',
      `<p>${escapeHtml(hello)}</p><p>Confirm your email address to finish setting up your account.</p>${button(params.url, 'Verify email')}<p style="font-size:13px;color:#4b5563">The link expires in ${escapeHtml(params.expiresInText)}. If you did not create an account, ignore this email.</p>`,
    ),
  };
}

export function passwordResetEmail(params: {
  to: string;
  name: string | null;
  url: string;
  expiresInText: string;
}): MailMessage {
  const hello = greeting(params.name);
  return {
    to: params.to,
    subject: `Reset your ${APP_NAME} password`,
    text: `${hello}\n\nSomeone asked to reset the password for this account. Open this link to choose a new one:\n${params.url}\n\nThe link expires in ${params.expiresInText} and can be used once. If it was not you, ignore this email; your password stays the same.`,
    html: layout(
      'Reset your password',
      `<p>${escapeHtml(hello)}</p><p>Someone asked to reset the password for this account.</p>${button(params.url, 'Choose a new password')}<p style="font-size:13px;color:#4b5563">The link expires in ${escapeHtml(params.expiresInText)} and can be used once. If it was not you, ignore this email; your password stays the same.</p>`,
    ),
  };
}

export function passwordChangedEmail(params: {
  to: string;
  name: string | null;
  resetUrl: string;
}): MailMessage {
  const hello = greeting(params.name);
  return {
    to: params.to,
    subject: `Your ${APP_NAME} password was changed`,
    text: `${hello}\n\nThe password for your account was just changed and other devices were signed out.\n\nIf this was not you, reset your password now: ${params.resetUrl}`,
    html: layout(
      'Your password was changed',
      `<p>${escapeHtml(hello)}</p><p>The password for your account was just changed and other devices were signed out.</p><p>If this was not you, reset your password now.</p>${button(params.resetUrl, 'Reset password')}`,
    ),
  };
}

const ROLE_LABEL: Record<string, string> = {
  VIEWER: 'viewer',
  EDITOR: 'editor',
  ADMIN: 'admin',
  MEMBER: 'member',
};
const roleLabel = (role: string): string =>
  ROLE_LABEL[role] ?? role.toLowerCase();

function quote(message: string | null | undefined): {
  text: string;
  html: string;
} {
  if (!message) return { text: '', html: '' };
  return {
    text: `\n\nMessage:\n"${message}"`,
    html: `<blockquote style="margin:16px 0;padding:12px 16px;background:#f3f4f6;border-left:4px solid #2563eb;color:#374151">${escapeHtml(message)}</blockquote>`,
  };
}

/** Invitation to a project for someone without an account yet. */
export function projectInvitationEmail(params: {
  to: string;
  projectName: string;
  inviterName: string;
  role: string;
  url: string;
  message?: string | null;
  expiresInText: string;
}): MailMessage {
  const role = roleLabel(params.role);
  const note = quote(params.message);
  return {
    to: params.to,
    subject: `${params.inviterName} invited you to "${params.projectName}" on ${APP_NAME}`,
    text: `Hi,\n\n${params.inviterName} invited you to collaborate on "${params.projectName}" as ${role}.${note.text}\n\nAccept the invitation:\n${params.url}\n\nThe invitation expires in ${params.expiresInText}.`,
    html: layout(
      'You have been invited to a project',
      `<p>${escapeHtml(params.inviterName)} invited you to collaborate on <strong>${escapeHtml(params.projectName)}</strong> as ${escapeHtml(role)}.</p>${note.html}${button(params.url, 'Accept invitation')}<p style="font-size:13px;color:#4b5563">The invitation expires in ${escapeHtml(params.expiresInText)}.</p>`,
    ),
  };
}

/** Notice that an existing user was given access to a project. */
export function projectSharedEmail(params: {
  to: string;
  name: string | null;
  projectName: string;
  inviterName: string;
  role: string;
  url: string;
  message?: string | null;
}): MailMessage {
  const hello = greeting(params.name);
  const role = roleLabel(params.role);
  const note = quote(params.message);
  return {
    to: params.to,
    subject: `${params.inviterName} shared "${params.projectName}" with you`,
    text: `${hello}\n\n${params.inviterName} shared "${params.projectName}" with you as ${role}.${note.text}\n\nOpen it:\n${params.url}`,
    html: layout(
      'A project was shared with you',
      `<p>${escapeHtml(hello)}</p><p>${escapeHtml(params.inviterName)} shared <strong>${escapeHtml(params.projectName)}</strong> with you as ${escapeHtml(role)}.</p>${note.html}${button(params.url, 'Open project')}`,
    ),
  };
}

export function teamInvitationEmail(params: {
  to: string;
  teamName: string;
  inviterName: string;
  role: string;
  url: string;
  expiresInText: string;
}): MailMessage {
  const role = roleLabel(params.role);
  return {
    to: params.to,
    subject: `${params.inviterName} invited you to join ${params.teamName} on ${APP_NAME}`,
    text: `Hi,\n\n${params.inviterName} invited you to join the team "${params.teamName}" as ${role}.\n\nAccept the invitation:\n${params.url}\n\nThe invitation expires in ${params.expiresInText}.`,
    html: layout(
      'You have been invited to a team',
      `<p>${escapeHtml(params.inviterName)} invited you to join <strong>${escapeHtml(params.teamName)}</strong> as ${escapeHtml(role)}.</p>${button(params.url, 'Join team')}<p style="font-size:13px;color:#4b5563">The invitation expires in ${escapeHtml(params.expiresInText)}.</p>`,
    ),
  };
}

/** "30 minutes", "24 hours", "2 days". */
export function humanizeDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `${days} days`;
}
