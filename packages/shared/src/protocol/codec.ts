/**
 * Binary codec primitives for the Dawned wire protocol (little-endian).
 *
 * Design notes:
 * - Writers grow geometrically and are reusable (`reset()`) so the server can keep
 *   one writer per client and allocate nothing per tick.
 * - Readers bounds-check every read and throw {@link ProtocolError}; the packet
 *   router turns that into a disconnect rather than a crash (docs/tech/SECURITY.md §2).
 */

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: false });

export class BinaryWriter {
  private buffer: ArrayBuffer;
  private view: DataView;
  private bytes: Uint8Array;
  private offset = 0;

  constructor(initialCapacity = 1024) {
    this.buffer = new ArrayBuffer(initialCapacity);
    this.view = new DataView(this.buffer);
    this.bytes = new Uint8Array(this.buffer);
  }

  get length(): number {
    return this.offset;
  }

  reset(): this {
    this.offset = 0;
    return this;
  }

  private ensure(extra: number): void {
    const required = this.offset + extra;
    if (required <= this.buffer.byteLength) return;
    let capacity = this.buffer.byteLength * 2;
    while (capacity < required) capacity *= 2;
    const next = new ArrayBuffer(capacity);
    new Uint8Array(next).set(this.bytes.subarray(0, this.offset));
    this.buffer = next;
    this.view = new DataView(next);
    this.bytes = new Uint8Array(next);
  }

  u8(value: number): this {
    this.ensure(1);
    this.view.setUint8(this.offset, value & 0xff);
    this.offset += 1;
    return this;
  }

  i8(value: number): this {
    this.ensure(1);
    this.view.setInt8(this.offset, value);
    this.offset += 1;
    return this;
  }

  u16(value: number): this {
    this.ensure(2);
    this.view.setUint16(this.offset, value & 0xffff, true);
    this.offset += 2;
    return this;
  }

  i16(value: number): this {
    this.ensure(2);
    this.view.setInt16(this.offset, value, true);
    this.offset += 2;
    return this;
  }

  u32(value: number): this {
    this.ensure(4);
    this.view.setUint32(this.offset, value >>> 0, true);
    this.offset += 4;
    return this;
  }

  f32(value: number): this {
    this.ensure(4);
    this.view.setFloat32(this.offset, value, true);
    this.offset += 4;
    return this;
  }

  f64(value: number): this {
    this.ensure(8);
    this.view.setFloat64(this.offset, value, true);
    this.offset += 8;
    return this;
  }

  /** UTF-8 string prefixed with a u16 byte length. */
  string(value: string): this {
    const encoded = textEncoder.encode(value);
    if (encoded.length > 0xffff) throw new ProtocolError('string too long for u16 length prefix');
    this.u16(encoded.length);
    this.ensure(encoded.length);
    this.bytes.set(encoded, this.offset);
    this.offset += encoded.length;
    return this;
  }

  bytes_(value: Uint8Array): this {
    this.ensure(value.length);
    this.bytes.set(value, this.offset);
    this.offset += value.length;
    return this;
  }

  /** Copy of the written region — safe to hand to a socket that may buffer it. */
  toUint8Array(): Uint8Array {
    return this.bytes.slice(0, this.offset);
  }
}

export class BinaryReader {
  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  private offset = 0;

  constructor(data: ArrayBuffer | Uint8Array) {
    if (data instanceof Uint8Array) {
      this.bytes = data;
      this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    } else {
      this.bytes = new Uint8Array(data);
      this.view = new DataView(data);
    }
  }

  get remaining(): number {
    return this.bytes.byteLength - this.offset;
  }

  get consumed(): number {
    return this.offset;
  }

  private need(count: number): void {
    if (this.offset + count > this.bytes.byteLength) {
      throw new ProtocolError(
        `packet truncated: needed ${count} byte(s) at offset ${this.offset}, have ${this.remaining}`,
      );
    }
  }

  u8(): number {
    this.need(1);
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  i8(): number {
    this.need(1);
    const value = this.view.getInt8(this.offset);
    this.offset += 1;
    return value;
  }

  u16(): number {
    this.need(2);
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  i16(): number {
    this.need(2);
    const value = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return value;
  }

  u32(): number {
    this.need(4);
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  f32(): number {
    this.need(4);
    const value = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return value;
  }

  f64(): number {
    this.need(8);
    const value = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return value;
  }

  string(): string {
    const length = this.u16();
    this.need(length);
    const value = textDecoder.decode(this.bytes.subarray(this.offset, this.offset + length));
    this.offset += length;
    return value;
  }
}

// ---------------------------------------------------------------------------
// Quantization helpers
// ---------------------------------------------------------------------------

const ANGLE_SCALE = 65535 / (Math.PI * 2);

/** Pack an angle in radians into a u16 (≈0.0055° resolution). */
export const quantizeAngle = (radians: number): number => {
  const twoPi = Math.PI * 2;
  let r = radians % twoPi;
  if (r < 0) r += twoPi;
  return Math.round(r * ANGLE_SCALE) & 0xffff;
};

/** Unpack a u16-quantized angle back into radians. */
export const dequantizeAngle = (packed: number): number => packed / ANGLE_SCALE;

/** Pack a 0..1 fraction into a u8. */
export const quantizeUnit = (value: number): number =>
  Math.round(Math.max(0, Math.min(1, value)) * 255);

/** Unpack a u8 fraction back into 0..1. */
export const dequantizeUnit = (packed: number): number => packed / 255;
