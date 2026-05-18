export interface CroutonConfig {
  port: number;
  host: string;
  vmDir: string;
  firmwareDir: string;
  imageDir: string;
  bridgeInterface: string;
  chBinary: string;
}

export const config: CroutonConfig = {
  port: parseInt(process.env.PORT ?? "3000"),
  host: process.env.HOST ?? "0.0.0.0",
  vmDir: process.env.VM_DIR ?? "/home/eve/vm",
  firmwareDir: process.env.FIRMWARE_DIR ?? "/home/eve/firmware",
  imageDir: process.env.IMAGE_DIR ?? "/home/eve/images",
  bridgeInterface: process.env.BRIDGE_INTF ?? "br0",
  chBinary: process.env.CH_BINARY ?? "./cloud-hypervisor/target/release/cloud-hypervisor",
};
