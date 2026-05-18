export type VMState = "stopped" | "booting" | "running" | "stopping" | "error";

export type BootMode = "direct" | "uefi" | "unknown";

export interface VMConfig {
  name: string;
  cpus?: number;
  memoryMb?: number;
  bootMode: BootMode;
  kernelPath?: string;
  disks: string[];
}

export interface VMInstance {
  name: string;
  state: VMState;
  pid?: number;
  tapInterface?: string;
  mac: string;
  ip?: string;
  startedAt?: Date;
  config: VMConfig;
}
