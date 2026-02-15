// ── Audio conversion utilities (Node.js version) ──────────────────────

// μ-law decode table
const MULAW_DECODE_TABLE = new Int16Array(256);
(() => {
  for (let i = 0; i < 256; i++) {
    let mu = ~i & 0xff;
    const sign = mu & 0x80 ? -1 : 1;
    mu = mu & 0x7f;
    const exponent = (mu >> 4) & 0x07;
    const mantissa = mu & 0x0f;
    let sample = ((mantissa << 1) + 33) << (exponent + 2);
    sample -= 0x84;
    MULAW_DECODE_TABLE[i] = sign * sample;
  }
})();

// μ-law encode lookup table (ITU G.711 standard)
const MULAW_ENCODE_TABLE = [
  0,0,1,1,2,2,2,2,3,3,3,3,3,3,3,3,
  4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,
  5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,
  5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,
  6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,
  6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,
  6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,
  6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,
  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
];

function linearToMulaw(sample: number): number {
  const BIAS = 0x84;
  const CLIP = 32635;
  const sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  sample = sample + BIAS;
  if (sample > CLIP) sample = CLIP;
  const exponent = MULAW_ENCODE_TABLE[(sample >> 7) & 0xFF];
  const mantissa = (sample >> (exponent + 3)) & 0x0F;
  return ~(sign | (exponent << 4) | mantissa) & 0xFF;
}

function mulawToPcm16(mulawBytes: Uint8Array): Int16Array {
  const pcm = new Int16Array(mulawBytes.length);
  for (let i = 0; i < mulawBytes.length; i++) {
    pcm[i] = MULAW_DECODE_TABLE[mulawBytes[i]];
  }
  return pcm;
}

function upsample3x(input: Int16Array): Int16Array {
  const output = new Int16Array(input.length * 3);
  for (let i = 0; i < input.length - 1; i++) {
    const s0 = input[i];
    const s1 = input[i + 1];
    output[i * 3] = s0;
    output[i * 3 + 1] = Math.round(s0 + (s1 - s0) / 3);
    output[i * 3 + 2] = Math.round(s0 + (2 * (s1 - s0)) / 3);
  }
  const last = input.length - 1;
  output[last * 3] = input[last];
  output[last * 3 + 1] = input[last];
  output[last * 3 + 2] = input[last];
  return output;
}

function downsample3x(input: Int16Array): Int16Array {
  const output = new Int16Array(Math.floor(input.length / 3));
  for (let i = 0; i < output.length; i++) {
    output[i] = input[i * 3];
  }
  return output;
}

function pcm16ToMulaw(pcm: Int16Array): Uint8Array {
  const mulaw = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    mulaw[i] = linearToMulaw(pcm[i]);
  }
  return mulaw;
}

/** Convert base64 mulaw 8kHz -> base64 PCM16 24kHz (Twilio -> OpenAI) */
export function twilioToOpenAI(base64Mulaw: string): string {
  const raw = Buffer.from(base64Mulaw, "base64");
  const pcm8k = mulawToPcm16(new Uint8Array(raw));
  const pcm24k = upsample3x(pcm8k);
  const bytes = Buffer.from(pcm24k.buffer, pcm24k.byteOffset, pcm24k.byteLength);
  return bytes.toString("base64");
}

/** Convert base64 PCM16 24kHz -> base64 mulaw 8kHz (OpenAI -> Twilio) */
export function openAIToTwilio(base64Pcm16: string): string {
  const raw = Buffer.from(base64Pcm16, "base64");
  const evenLength = raw.byteLength & ~1;
  const pcm24k = new Int16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + evenLength));
  const pcm8k = downsample3x(pcm24k);
  const mulaw = pcm16ToMulaw(pcm8k);
  return Buffer.from(mulaw).toString("base64");
}
