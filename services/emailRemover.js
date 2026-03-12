"use strict";

const sysconfig = require("./sysconfig");

let transporter = null;

/** Reset cached transporter — called automatically by sysconfig when SMTP settings change */
function resetTransporter() {
  transporter = null;
}

function getTransporter() {
  if (transporter) return transporter;

  const host = sysconfig.get("smtp_host");
  if (!host) return null;

  const nodemailer = require("nodemailer");
  transporter = nodemailer.createTransport({
    host,
    port: parseInt(sysconfig.get("smtp_port")) || 587,
    secure: sysconfig.get("smtp_secure") === "true",
    auth: {
      user: sysconfig.get("smtp_user") || undefined,
      pass: sysconfig.get("smtp_pass") || undefined,
    },
  });
  return transporter;
}

const DEFAULT_SUBJECT = (brokerName) => `Data Removal Request — ${brokerName}`;

function buildEmailBody(brokerName, profile, customBody) {
  if (customBody) return customBody;

  const name = profile.full_name || "";
  const email =
    profile.emails && profile.emails.length > 0
      ? profile.emails[0].address || profile.emails[0]
      : "";
  const phone =
    profile.phones && profile.phones.length > 0
      ? profile.phones[0].number || profile.phones[0]
      : "";
  const address =
    profile.addresses && profile.addresses.length > 0
      ? profile.addresses[0]
      : {};
  const addrStr = [address.street, address.city, address.state, address.zip]
    .filter(Boolean)
    .join(", ");

  return `To Whom It May Concern,

I am writing to request the immediate removal of my personal information from ${brokerName}'s database and all associated websites.

My information:
- Full Name: ${name}
${email ? `- Email: ${email}\n` : ""}\
${phone ? `- Phone: ${phone}\n` : ""}\
${addrStr ? `- Address: ${addrStr}\n` : ""}\

Under applicable privacy regulations including the CCPA (California Consumer Privacy Act), GDPR, and other relevant state and federal privacy laws, I have the right to request deletion of my personal data. I hereby exercise this right and request that you:

1. Remove all records, profiles, and data associated with me from your database.
2. Ensure my information is not re-added or re-sold to third parties.
3. Confirm removal in writing within the legally required timeframe.

Please confirm receipt of this request and provide the expected timeline for compliance.

Regards,
${name}`.trim();
}

async function sendOptOutEmail(broker, profile, aiDraft) {
  const transport = getTransporter();
  const from = sysconfig.get("smtp_from") || sysconfig.get("smtp_user") || "";
  const to = broker.contact_email;

  if (!transport) {
    console.warn("[EmailRemover] SMTP not configured — email not sent to:", to);
    return {
      success: false,
      notes: "SMTP not configured — configure it in Settings → System",
    };
  }

  if (!to) {
    return {
      success: false,
      notes: "No contact email configured for this broker",
    };
  }

  const brokerName = broker.name || broker.broker_name || "Unknown Broker";
  const body = buildEmailBody(brokerName, profile, aiDraft);

  try {
    const info = await transport.sendMail({
      from,
      to,
      subject: DEFAULT_SUBJECT(brokerName),
      text: body,
    });
    return {
      success: true,
      response_body: info.messageId,
      notes: `Email sent: ${info.messageId}`,
    };
  } catch (err) {
    console.error("[EmailRemover] Send failed:", err.message);
    return { success: false, notes: `Email failed: ${err.message}` };
  }
}

module.exports = { sendOptOutEmail, buildEmailBody, resetTransporter };
