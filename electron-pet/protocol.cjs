"use strict";

const PROTOCOL_VERSION = 1;
const MESSAGE_PREFIX = "CLI_MANAGER_DESKTOP_PET ";
const MAX_PROTOCOL_LINE_LENGTH = 1024 * 1024;

function encodeMessage(message) {
  return `${MESSAGE_PREFIX}${JSON.stringify(message)}\n`;
}

function parseMessage(line) {
  if (typeof line !== "string" || line.length > MAX_PROTOCOL_LINE_LENGTH) return null;
  if (!line.startsWith(MESSAGE_PREFIX)) return null;
  try {
    const message = JSON.parse(line.slice(MESSAGE_PREFIX.length));
    return message && typeof message === "object" ? message : null;
  } catch {
    return null;
  }
}

function isProtocolMessage(message, kind) {
  return Boolean(
    message
      && message.protocolVersion === PROTOCOL_VERSION
      && message.kind === kind
  );
}

module.exports = {
  MESSAGE_PREFIX,
  MAX_PROTOCOL_LINE_LENGTH,
  PROTOCOL_VERSION,
  encodeMessage,
  isProtocolMessage,
  parseMessage,
};
