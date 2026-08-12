import * as fs from 'fs';
import { createRequire } from 'module';

export interface SecureFileIdentity {
  device: string;
  inode: string;
}

export class SecureFilesystemUnavailableError extends Error {
  constructor() {
    super('Descriptor-relative semantic storage is unavailable on this platform.');
    this.name = 'SecureFilesystemUnavailableError';
  }
}

export class SecureFilesystemOperationError extends Error {
  constructor(
    public readonly code: string,
    public readonly errno: number,
    operation: string
  ) {
    super(`Descriptor-relative filesystem operation failed: ${operation} (${code}).`);
    this.name = 'SecureFilesystemOperationError';
  }
}

interface PosixSyscalls {
  koffi: typeof import('koffi');
  openat: (
    directoryFd: number,
    name: string,
    flags: number,
    modeType: string,
    mode: number
  ) => number;
  mkdirat: (directoryFd: number, name: string, mode: number) => number;
  renameat: (
    sourceDirectoryFd: number,
    sourceName: string,
    destinationDirectoryFd: number,
    destinationName: string
  ) => number;
  unlinkat: (directoryFd: number, name: string, flags: number) => number;
  errnoNames: Map<number, string>;
}

const require = createRequire(import.meta.url);
let loadedSyscalls: PosixSyscalls | null = null;
const posixConstants = fs.constants as typeof fs.constants & {
  O_CLOEXEC?: number;
};

function assertSupportedPlatform(): void {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new SecureFilesystemUnavailableError();
  }
}

function syscalls(): PosixSyscalls {
  assertSupportedPlatform();
  if (loadedSyscalls) return loadedSyscalls;

  const koffi = require('koffi') as typeof import('koffi');
  const libc = koffi.load(null);
  const errnoNames = new Map<number, string>();
  for (const [name, value] of Object.entries(koffi.os.errno)) {
    if (typeof value === 'number' && !errnoNames.has(value)) errnoNames.set(value, name);
  }
  loadedSyscalls = {
    koffi,
    openat: libc.func(
      'openat',
      'int',
      ['int', 'str', 'int', '...']
    ) as PosixSyscalls['openat'],
    mkdirat: libc.func(
      'mkdirat',
      'int',
      ['int', 'str', 'uint']
    ) as PosixSyscalls['mkdirat'],
    renameat: libc.func(
      'renameat',
      'int',
      ['int', 'str', 'int', 'str']
    ) as PosixSyscalls['renameat'],
    unlinkat: libc.func(
      'unlinkat',
      'int',
      ['int', 'str', 'int']
    ) as PosixSyscalls['unlinkat'],
    errnoNames,
  };
  return loadedSyscalls;
}

function safeBasename(name: string): string {
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0')
  ) {
    throw new Error('Descriptor-relative filesystem names must be one safe path component.');
  }
  return name;
}

function throwPosixFailure(operation: string): never {
  const loaded = syscalls();
  const errno = loaded.koffi.errno();
  throw new SecureFilesystemOperationError(
    loaded.errnoNames.get(errno) ?? `ERRNO_${errno}`,
    errno,
    operation
  );
}

function identityOf(stat: fs.BigIntStats): SecureFileIdentity {
  return {
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
  };
}

export function sameSecureIdentity(
  left: SecureFileIdentity,
  right: SecureFileIdentity
): boolean {
  return left.device === right.device && left.inode === right.inode;
}

export function secureMutationSupported(
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform === 'darwin' || platform === 'linux';
}

export function openPinnedDirectory(
  directoryPath: string,
  expectedIdentity: SecureFileIdentity
): number {
  assertSupportedPlatform();
  const flags = fs.constants.O_RDONLY |
    (fs.constants.O_DIRECTORY ?? 0) |
    (fs.constants.O_NOFOLLOW ?? 0) |
    (posixConstants.O_CLOEXEC ?? 0);
  const descriptor = fs.openSync(directoryPath, flags);
  try {
    const stat = fs.fstatSync(descriptor, { bigint: true });
    if (!stat.isDirectory() || !sameSecureIdentity(identityOf(stat), expectedIdentity)) {
      throw new Error('Pinned directory identity changed before descriptor-relative use.');
    }
    return descriptor;
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

export function openDirectoryAt(directoryFd: number, name: string): number {
  const loaded = syscalls();
  const flags = fs.constants.O_RDONLY |
    (fs.constants.O_DIRECTORY ?? 0) |
    (fs.constants.O_NOFOLLOW ?? 0) |
    (posixConstants.O_CLOEXEC ?? 0);
  const descriptor = loaded.openat(
    directoryFd,
    safeBasename(name),
    flags,
    'uint',
    0
  );
  if (descriptor < 0) throwPosixFailure('open_directory');
  try {
    if (!fs.fstatSync(descriptor, { bigint: true }).isDirectory()) {
      throw new Error('Descriptor-relative directory entry is not a directory.');
    }
    return descriptor;
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

export function openFileAt(
  directoryFd: number,
  name: string,
  flags: number,
  mode = 0
): number {
  const loaded = syscalls();
  const descriptor = loaded.openat(
    directoryFd,
    safeBasename(name),
    flags | (fs.constants.O_NOFOLLOW ?? 0) | (posixConstants.O_CLOEXEC ?? 0),
    'uint',
    mode
  );
  if (descriptor < 0) throwPosixFailure('open_file');
  return descriptor;
}

export function mkdirAt(directoryFd: number, name: string, mode: number): void {
  const loaded = syscalls();
  if (loaded.mkdirat(directoryFd, safeBasename(name), mode) < 0) {
    throwPosixFailure('mkdir');
  }
}

export function renameAt(
  directoryFd: number,
  sourceName: string,
  destinationName: string
): void {
  const loaded = syscalls();
  if (
    loaded.renameat(
      directoryFd,
      safeBasename(sourceName),
      directoryFd,
      safeBasename(destinationName)
    ) < 0
  ) {
    throwPosixFailure('rename');
  }
}

export function unlinkAt(directoryFd: number, name: string): void {
  const loaded = syscalls();
  if (loaded.unlinkat(directoryFd, safeBasename(name), 0) < 0) {
    throwPosixFailure('unlink');
  }
}

export function fsyncDirectory(directoryFd: number): void {
  fs.fsyncSync(directoryFd);
}

export function descriptorIdentity(descriptor: number): SecureFileIdentity {
  const stat = fs.fstatSync(descriptor, { bigint: true });
  if (!stat.isFile() && !stat.isDirectory()) {
    throw new Error('Descriptor-relative entry has an invalid physical type.');
  }
  return identityOf(stat);
}
