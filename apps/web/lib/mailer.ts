import nodemailer from "nodemailer";
import { APP_NAME } from "@tempo/shared";

interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Outbound email. Uses SMTP when configured; otherwise logs the message so local development and
 * environments without an email provider still work (links are printed to the server console).
 */
export async function sendMail(mail: Mail): Promise<void> {
  const host = process.env.SMTP_HOST;
  const from = process.env.EMAIL_FROM ?? `${APP_NAME} <no-reply@localhost>`;
  if (!host) {
    console.info(`\n[mail → ${mail.to}] ${mail.subject}\n${mail.text}\n`);
    return;
  }
  const transport = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: Number(process.env.SMTP_PORT ?? 587) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  await transport.sendMail({ from, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html });
}

export function emailLayout(title: string, body: string, cta?: { label: string; url: string }): string {
  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0f1216;color:#eef0f3;padding:32px">
  <div style="max-width:520px;margin:0 auto;background:#171c23;border:1px solid #2a313c;border-radius:14px;padding:28px">
    <div style="font-weight:700;font-size:20px;color:#f0a53a;margin-bottom:12px">${APP_NAME}</div>
    <h1 style="font-size:18px;margin:0 0 12px">${title}</h1>
    <p style="line-height:1.6;color:#9aa3b0">${body}</p>
    ${cta ? `<p style="margin:24px 0"><a href="${cta.url}" style="display:inline-block;background:#f0a53a;color:#1a1203;text-decoration:none;font-weight:600;padding:12px 18px;border-radius:10px">${cta.label}</a></p><p style="font-size:12px;color:#6b7482;word-break:break-all">${cta.url}</p>` : ""}
  </div></body></html>`;
}
