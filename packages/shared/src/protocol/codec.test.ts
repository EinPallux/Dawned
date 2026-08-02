import { describe, expect, it } from 'vitest';
import {
  BinaryReader,
  BinaryWriter,
  ProtocolError,
  dequantizeAngle,
  dequantizeUnit,
  quantizeAngle,
  quantizeUnit,
} from './codec.js';

describe('BinaryWriter / BinaryReader', () => {
  it('round-trips every primitive in order', () => {
    const w = new BinaryWriter(4); // deliberately tiny: forces growth
    w.u8(255)
      .i8(-128)
      .u16(65535)
      .i16(-32768)
      .u32(4294967295)
      .f32(1.5)
      .f64(Math.PI)
      .string('Dawnhaven ⚔ 日本語');

    const r = new BinaryReader(w.toUint8Array());
    expect(r.u8()).toBe(255);
    expect(r.i8()).toBe(-128);
    expect(r.u16()).toBe(65535);
    expect(r.i16()).toBe(-32768);
    expect(r.u32()).toBe(4294967295);
    expect(r.f32()).toBe(1.5);
    expect(r.f64()).toBe(Math.PI);
    expect(r.string()).toBe('Dawnhaven ⚔ 日本語');
    expect(r.remaining).toBe(0);
  });

  it('grows geometrically without corrupting earlier writes', () => {
    const w = new BinaryWriter(1);
    for (let i = 0; i < 5000; i++) w.u32(i);
    const r = new BinaryReader(w.toUint8Array());
    for (let i = 0; i < 5000; i++) expect(r.u32()).toBe(i);
  });

  it('reset() reuses the buffer for the next message', () => {
    const w = new BinaryWriter(64);
    w.u32(1).u32(2);
    expect(w.length).toBe(8);
    w.reset().u8(7);
    expect(w.length).toBe(1);
    expect(new BinaryReader(w.toUint8Array()).u8()).toBe(7);
  });

  it('throws ProtocolError on truncated reads instead of returning garbage', () => {
    const w = new BinaryWriter();
    w.u16(1);
    const r = new BinaryReader(w.toUint8Array());
    r.u16();
    expect(() => r.u32()).toThrow(ProtocolError);
  });

  it('throws ProtocolError on a truncated string body', () => {
    // Claims a 60-byte string but supplies none.
    const bytes = new Uint8Array([60, 0]);
    expect(() => new BinaryReader(bytes).string()).toThrow(ProtocolError);
  });

  it('survives arbitrary junk without crashing the process', () => {
    // Fuzz-lite: random bytes must only ever produce ProtocolError, never a hang or TypeError.
    let seed = 0x2f6e2b1;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let iteration = 0; iteration < 500; iteration++) {
      const length = Math.floor(rand() * 32);
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) bytes[i] = Math.floor(rand() * 256);
      const r = new BinaryReader(bytes);
      try {
        r.u8();
        r.u16();
        r.f32();
        r.string();
      } catch (error) {
        expect(error).toBeInstanceOf(ProtocolError);
      }
    }
  });
});

describe('quantization', () => {
  it('keeps angles within a fraction of a degree', () => {
    for (let a = 0; a < Math.PI * 2; a += 0.017) {
      const error = Math.abs(dequantizeAngle(quantizeAngle(a)) - a);
      expect(error).toBeLessThan(0.0002);
    }
  });

  it('normalizes negative angles into range', () => {
    const packed = quantizeAngle(-Math.PI / 2);
    expect(dequantizeAngle(packed)).toBeCloseTo((3 * Math.PI) / 2, 3);
  });

  it('clamps and round-trips unit fractions', () => {
    expect(dequantizeUnit(quantizeUnit(0))).toBe(0);
    expect(dequantizeUnit(quantizeUnit(1))).toBe(1);
    expect(dequantizeUnit(quantizeUnit(-5))).toBe(0);
    expect(dequantizeUnit(quantizeUnit(5))).toBe(1);
    expect(dequantizeUnit(quantizeUnit(0.5))).toBeCloseTo(0.5, 2);
  });
});
