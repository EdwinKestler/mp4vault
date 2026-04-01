export interface IReadable {
  isPrepared(): boolean;
  prepare(): Promise<void>;
  close(): Promise<void>;
  getSlice(offset: number, length: number): Promise<Uint8Array>;
  size(): Promise<number>;
}

export interface IWritable {
  size(): number;
  prepare(): Promise<void>;
  close(): Promise<void>;
  write(data: Uint8Array | number[]): Promise<void>;
  saveToFile(filename: string): Promise<void>;
  toReadable(): Promise<IReadable>;
}

export interface AtomParams {
  readable?: IReadable;
  name: string;
  start: number;
  size: number;
  header_size: number;
  mother?: Atom | null;
}

export interface FileRecord {
  filename: string;
  size: number;
  meta?: Record<string, unknown>;
  isEncrypted?: boolean;
  offset?: number;
  inner?: boolean;
}

export interface EmbedFileParams {
  filename?: string;
  file?: unknown;
  meta?: Record<string, unknown>;
  key?: Buffer | null;
  password?: string | null;
  inner?: boolean;
}

// Forward declaration to avoid circular imports
import type { Atom } from './Atom.js';
