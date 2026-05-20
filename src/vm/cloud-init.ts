import path from "path";
import { writeFile } from "fs/promises";
import { $ } from "bun";

/**
 * Default cloud-init `user-data` template for new VMs. Includes growpart +
 * resize_rootfs (so the resized qcow2 is actually usable from inside the
 * guest), a swapfile, and a commented-out user block with SSH keys so the
 * common shape is right there to uncomment.
 */
export const DEFAULT_USER_DATA = `#cloud-config

# Grow the root partition + filesystem to fill the resized disk
growpart:
  mode: auto
  devices: ['/']
resize_rootfs: true

# Configure a swapfile
swap:
  filename: /swapfile
  size: 2G
  maxsize: 4G

package_update: true
package_upgrade: false

packages:
  - curl

# Uncomment and customise to add a user with SSH access:
# users:
#   - default
#   - name: yourname
#     groups: [sudo]
#     shell: /bin/bash
#     sudo: ['ALL=(ALL) NOPASSWD:ALL']
#     lock_passwd: true
#     ssh_authorized_keys:
#       - ssh-ed25519 AAAA... your-key-here

# runcmd:
#   - [ sh, -c, "echo provisioned" ]
`;

/**
 * Builds a NoCloud seed.iso for a VM. Writes `user-data` and `meta-data`
 * into the VM directory alongside the disk, then invokes `cloud-localds`
 * (falling back to `genisoimage`) to produce the ISO that Cloud Hypervisor
 * attaches as a read-only second disk.
 *
 * @param vmDir - Absolute path to the VM directory.
 * @param name - VM name (used for `instance-id` and `local-hostname`).
 * @param userData - The full `#cloud-config` YAML body to embed.
 */
export async function buildSeedIso(vmDir: string, name: string, userData: string): Promise<void> {
  const userDataPath = path.join(vmDir, "user-data");
  const metaDataPath = path.join(vmDir, "meta-data");
  const seedPath = path.join(vmDir, "seed.iso");

  const metaData = `instance-id: i-${name}\nlocal-hostname: ${name}\n`;

  await writeFile(userDataPath, userData);
  await writeFile(metaDataPath, metaData);

  try {
    await $`cloud-localds ${seedPath} ${userDataPath} ${metaDataPath}`.quiet();
    return;
  } catch {
    // cloud-localds missing — fall through to genisoimage
  }

  try {
    await $`genisoimage -output ${seedPath} -volid cidata -joliet -rock ${userDataPath} ${metaDataPath}`.quiet();
  } catch (err) {
    throw new Error(
      "failed to build seed.iso — install `cloud-image-utils` (cloud-localds) or `genisoimage`",
      { cause: err },
    );
  }
}
