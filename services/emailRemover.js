'use strict';

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  const nodemailer = require('nodemailer');
  const host = process.env.SMTP_HOST;
  if (!host) return null;

  transporter = nodemailer.createTransport({
    host,
    port:   parseInt(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transporter;
}

const DEFAULT_SUBJECT = (brokerName) => `Data Removal Request — ${brokerName}`;

function buildEmailBody(brokerName, profile, customBody) {
  if (customBody) return customBody;

  const name    = profile.full_name || '';
  const email   = profile.emails && profile.emails.length > 0 ? (profile.emails[0].address || profile.emails[0]) : '';
  const phone   = profile.phones && profile.phones.length > 0 ? (profile.phones[0].number  || profile.phones[0]) : '';
  const address = profile.addresses && profile.addresses.length > 0 ? profile.addresses[0] : {};
  const addrStr = [address.street, address.city, address.state, address.zip].filter(Boolean).join(', ');

  return `To Whom It May Concern,

I am writing to request the immediate removal of my personal information from ${brokerName}'s database and all associated websites.

My information:
- Full Name: ${name}
${email   ? `- Email: ${email}\n` : ''}\
${phone   ? `- Phone: ${phone}\n` : ''}\
${addrStr ? `- Address: ${addrStr}\n` : ''}\

Under applicable privacy regulations including the CCPA (California Consumer Privacy Act), GDPR, and other relevant state and federal privacy laws, I have the right to request deletion of my personal data. I hereby exercise this right and request that you:

1. Remove all records, profiles, and data associated with me from your database.
2. Ensure my information is not re-added or re-sold.
3. Confirm removal in writing within the legally required timeframe.

Please confirm receipt of this request and the expected timeline for compliance.

Regards,
${name}
`.trim();
}

async function sendOptOutEmail(broker, profile, aiDraft) {
  const transport = getTransporter();
  // Zoho (and most SMTP servers) only allow sending FROM the authenticated user
  const from = process.env.SMTP_USER || '';
  const to   = broker.contact_email;

  if (!transport) {
    // Fallback: log email content if no SMTP configured
    console.log('[EmailRemover] No SMTP configured. Would have sent to:', to);
    return { success: false, notes: 'SMTP not configured — email not sent' };
  }
  if (!to) return { success: false, notes: 'No contact email for broker' };

  const body = buildEmailBody(broker.name || broker.broker_name, profile, aiDraft);

  try {
    const info = await transport.sendMail({
      from,
      to,
      subject: DEFAULT_SUBJECT(broker.name || broker.broker_name),
      text: body,
    });
    return { success: true, response_body: info.messageId, notes: `Email sent: ${info.messageId}` };
  } catch (err) {
    return { success: false, notes: `Email failed: ${err.message}` };
  }
}

module.exports = { sendOptOutEmail, buildEmailBody };
