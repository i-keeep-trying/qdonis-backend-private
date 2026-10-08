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

/** "30 minutes", "24 hours", "2 days". */
export function humanizeDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `${days} days`;
}
