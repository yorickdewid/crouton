/**
 * Runtime configuration resolved from environment variables with local defaults.
 */
export interface CroutonConfig {
  /** HTTP port for the Bun server. */
  port: number;
  /** Bind address for the Bun server. */
  host: string;
  /** Root directory containing VM instance data. */
  vmDir: string;
  /** Directory containing firmware images used for VM boot. */
  firmwareDir: string;
  /** Directory containing VM disk images. */
  imageDir: string;
  /** Host bridge interface used for VM networking. */
  bridgeInterface: string;
  /** Filesystem path to the cloud-hypervisor binary. */
  chBinary: string;
}

/**
 * Process-wide configuration for Crouton.
 */
export const config: CroutonConfig = {
  port: parseInt(process.env.PORT ?? "3000"),
  host: process.env.HOST ?? "0.0.0.0",
  vmDir: process.env.VM_DIR ?? "/home/eve/vm",
  firmwareDir: process.env.FIRMWARE_DIR ?? "/home/eve/firmware",
  imageDir: process.env.IMAGE_DIR ?? "/home/eve/images",
  bridgeInterface: process.env.BRIDGE_INTF ?? "br0",
  chBinary: process.env.CH_BINARY ?? "./cloud-hypervisor/target/release/cloud-hypervisor",
};
