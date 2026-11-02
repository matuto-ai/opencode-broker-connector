import { validateEnvelope } from '../vendor/broker/src/protocol.mjs';

export const PREVIEW_TEXT_LIMIT = 160;
export const PREVIEW_SENDER_LIMIT = 40;
// This is a presentation-only preview, not a replacement for the full compact-v1
// body. Persist it with each new admission; never recompute a stored payload.
const unsafe = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b\u2060\ufeff]|\p{Bidi_Control}/u;
function literal(value, limit) {
  const tokens = []; let length = 0;
  for (const char of value) {
    const token = char === '\\' ? '\\\\' : unsafe.test(char)
      ? `\\u${char.codePointAt(0).toString(16).padStart(4, '0')}` : char;
    const size = [...token].length;
    if (length + size > limit) {
      while (length >= limit) length -= [...tokens.pop()].length;
      return tokens.join('') + '…';
    }
    tokens.push(token); length += size;
  }
  return tokens.join('');
}

/** Literal external-agent notice for the native history; no semantic summary. */
export function nativeDescription(rawEnvelope) {
  const envelope = validateEnvelope(rawEnvelope);
  const sender = literal(envelope.sender.name, PREVIEW_SENDER_LIMIT);
  const preview = literal(envelope.content.text, PREVIEW_TEXT_LIMIT);
  return `Psst · new message · From: ${sender} · ${envelope.sender.client_type} · ${preview}`;
}
